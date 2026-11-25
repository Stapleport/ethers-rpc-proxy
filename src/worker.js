import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { clientKey, createRateLimiter, createShortCache, CACHEABLE_RPC_METHODS } from './limits.js';
import {
    rpcConfig,
    pendingChains,
    lookupChain,
    parseChainRef,
    addressBook,
    handleRpcRequest,
    handleContractCall,
    resolveContractAddress,
    getSupportedContracts,
    getContractFunctions,
} from '../lib/rpcHandler.js';

const app = new Hono();

app.use('*', cors());

const rateLimiter = createRateLimiter({ limit: 60, windowMs: 60_000 });

app.use('*', async (c, next) => {
    if (c.req.method === 'OPTIONS') return next();
    const verdict = rateLimiter.check(clientKey(c.req.raw));
    c.header('X-RateLimit-Limit', '60');
    c.header('X-RateLimit-Remaining', String(verdict.remaining));
    if (!verdict.allowed) {
        c.header('Retry-After', String(verdict.retryAfter));
        return c.json(
            { success: false, error: 'Rate limit exceeded: 60 requests per minute per client. Retry later.' },
            429
        );
    }
    return next();
});

const rpcCache = createShortCache({ ttlMs: 5000 });

const methodNotAllowed = (c) => c.json({ success: false, error: 'Method not allowed' }, 405);

app.onError((err, c) => {
    console.error('Unhandled error:', err?.message || err);
    return c.json(
        { success: false, error: err?.message || 'Internal server error' },
        500,
        { 'Access-Control-Allow-Origin': '*' }
    );
});

const STATIC_CACHE = 'public, max-age=300, s-maxage=3600';

function customRpcAllowed(env) {
    const v = env?.ALLOW_CUSTOM_RPC;
    return v === true || String(v).toLowerCase() === 'true' || String(v) === '1';
}
const CUSTOM_RPC_DISABLED =
    'Custom upstream rpc is disabled on this instance: self-deploy and set ALLOW_CUSTOM_RPC=true (wrangler vars) to enable it.';

function get(path, handler) {
    app.get(path, handler);
    app.on(['POST', 'PUT', 'PATCH', 'DELETE'], path, methodNotAllowed);
}
function post(path, handler) {
    app.post(path, handler);
    app.on(['GET', 'PUT', 'PATCH', 'DELETE'], path, methodNotAllowed);
}

get('/api/health', (c) =>
    c.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        version: '2.0.0',
    })
);

get('/api/chains', (c) => {
    c.header('Cache-Control', STATIC_CACHE);
    return c.json({
        success: true,
        chains: [...rpcConfig, ...pendingChains].map((chain) => ({
            chainId: chain.chainId ?? null,
            name: chain.name,
            symbol: chain.nativeCurrency?.symbol,
            decimals: chain.nativeCurrency?.decimals,
            rpcUrls: chain.rpc.map((r) => r.url),
        })),
    });
});

get('/api/contracts', (c) => {
    c.header('Cache-Control', STATIC_CACHE);
    return c.json({
        success: true,
        contracts: getSupportedContracts(),
    });
});

get('/api/addresses', (c) => {
    c.header('Cache-Control', STATIC_CACHE);
    const chainIdParam = c.req.query('chainId');
    const key = chainIdParam ? String(parseChainRef(chainIdParam)) : null;
    return c.json({
        success: true,
        addresses: Object.fromEntries(
            Object.entries(addressBook).map(([name, entry]) => [
                name,
                {
                    abi: entry.abi,
                    description: entry.description,
                    address: key
                        ? entry.addresses[key] || entry.addresses['*'] || null
                        : entry.addresses,
                },
            ])
        ),
    });
});

get('/api/call', async (c) => {
    const chain = c.req.query('chain');
    const customRpc = c.req.query('rpc');
    const contract = c.req.query('contract');
    const fn = c.req.query('fn');
    const params = c.req.queries('p') || [];
    if (!contract || !fn || (!chain && !customRpc)) {
        return c.json(
            { success: false, error: 'Missing required query parameters: chain (or rpc), contract, fn (params via repeated p=)' },
            400
        );
    }
    if (customRpc && !customRpcAllowed(c.env)) {
        return c.json({ success: false, error: CUSTOM_RPC_DISABLED }, 403);
    }

    let chainCfg;
    try {
        chainCfg = await lookupChain(chain || undefined, customRpc);
    } catch (error) {
        console.error('Chain lookup error:', error.message);
        return c.json({ success: false, error: error.message }, error.status || 500);
    }
    const chainIdNum = chainCfg.chainId;

    const typed = params.map((p) => {
        if (/^-?\d+$/.test(p)) return p;
        if (p === 'true') return true;
        if (p === 'false') return false;
        try { return JSON.parse(p); } catch { return p; }
    });

    const resolved = resolveContractAddress(chainIdNum, contract);
    if (!resolved) {
        return c.json(
            { success: false, error: `Unknown contract reference: ${contract} (not a 0x address or address book entry)` },
            404
        );
    }
    const finalName = resolved.abi;
    if (!finalName) {
        return c.json(
            { success: false, error: 'contractName cannot be inferred for a raw 0x address via GET; use POST /api/contract/call' },
            400
        );
    }

    try {
        const result = await handleContractCall(chainIdNum, resolved.address, finalName, fn, typed, { customRpcUrl: customRpc });
        return c.json({
            success: true,
            result,
            callInfo: { chainId: chainIdNum, contractAddress: resolved.address, contractName: finalName, functionName: fn, params: typed },
        });
    } catch (error) {
        console.error('GET call error:', error.message);
        return c.json({ success: false, error: error.message }, error.status || 500);
    }
});

get('/api/contracts/:contractName/functions', (c) => {
    c.header('Cache-Control', STATIC_CACHE);
    const contractName = c.req.param('contractName');
    const functions = getContractFunctions(contractName);
    if (functions.length === 0) {
        return c.json(
            { success: false, error: `未找到合约 ${contractName} 或该合约没有函数` },
            404
        );
    }
    return c.json({ success: true, contractName, functions });
});

post('/api/rpc', async (c) => {
    const { chainId, request, rpc } = await c.req.json().catch(() => ({}));
    if (!request || (!chainId && !rpc)) {
        return c.json(
            {
                error: 'Missing required parameters',
                message: 'request is required, plus chainId (id or name) and/or rpc',
            },
            400
        );
    }
    if (rpc && !customRpcAllowed(c.env)) {
        return c.json({ success: false, error: CUSTOM_RPC_DISABLED }, 403);
    }
    const cacheable =
        CACHEABLE_RPC_METHODS.has(request?.method) &&
        Array.isArray(request.params) &&
        request.params.length === 0 &&
        !rpc;
    const cacheKey = cacheable ? `${chainId ?? ''}|${request.method}` : null;
    if (cacheKey) {
        const cached = rpcCache.get(cacheKey);
        if (cached !== undefined) {
            c.header('X-Proxy-Cache', 'HIT');
            return c.json({ success: true, result: cached });
        }
    }
    try {
        const result = await handleRpcRequest(request, chainId, { customRpcUrl: rpc });
        if (cacheKey) rpcCache.set(cacheKey, result);
        c.header('X-Proxy-Cache', cacheKey ? 'MISS' : 'BYPASS');
        return c.json({ success: true, result });
    } catch (error) {
        console.error('RPC request error:', error.message);
        return c.json({ success: false, error: error.message }, error.status || 500);
    }
});

post('/api/contract/call', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { chainId, contractAddress, contractName, functionName, rpc, abi } = body;
    const params = body.params || [];

    if (!Array.isArray(params)) {
        return c.json({ success: false, error: 'params must be an array' }, 400);
    }
    if (abi !== undefined && !Array.isArray(abi)) {
        return c.json({ success: false, error: 'abi must be an array of ABI fragments' }, 400);
    }

    if (!contractAddress || !functionName || (!chainId && !rpc)) {
        return c.json(
            { success: false, error: 'Missing required parameters: chainId (id or name, or just rpc), contractAddress, functionName' },
            400
        );
    }
    if (rpc && !customRpcAllowed(c.env)) {
        return c.json({ success: false, error: CUSTOM_RPC_DISABLED }, 403);
    }

    let chainCfg;
    try {
        chainCfg = await lookupChain(chainId, rpc);
    } catch (error) {
        console.error('Chain lookup error:', error.message);
        return c.json({ success: false, error: error.message }, error.status || 500);
    }

    const resolved = resolveContractAddress(chainCfg.chainId, contractAddress);
    if (!resolved) {
        return c.json(
            { success: false, error: `Unknown contract reference: ${contractAddress} (not a 0x address or address book entry)` },
            404
        );
    }
    const finalAddress = resolved.address;
    const finalName = contractName || resolved.abi;
    if (!finalName && !abi) {
        return c.json(
            { success: false, error: `contractName is required when calling by raw address (or pass a request-level "abi")` },
            400
        );
    }

    try {
        const result = await handleContractCall(chainCfg.chainId, finalAddress, finalName, functionName, params, { customRpcUrl: rpc, requestAbi: abi });
        return c.json({
            success: true,
            result,
            callInfo: { chainId, contractAddress: finalAddress, contractName: finalName, functionName, params },
        });
    } catch (error) {
        console.error('Contract call error:', error.message);
        return c.json({ success: false, error: error.message }, error.status || 500);
    }
});

export default app;
