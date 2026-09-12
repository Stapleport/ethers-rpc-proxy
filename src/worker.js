/**
 * Cloudflare Worker 入口（Hono）
 *
 * 路由与原 Next.js 版完全一致，响应结构不变（{success, ...} 信封），
 * 另外补齐两件事：
 * - CORS：浏览器前端跨域直连
 * - 状态码：404 链/合约不存在、403 写操作或方法不在白名单、502 上游全挂
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
    rpcConfig,
    pendingChains,
    lookupChain,
    addressBook,
    handleRpcRequest,
    handleContractCall,
    resolveContractAddress,
    getSupportedContracts,
    getContractFunctions,
} from '../lib/rpcHandler.js';

const app = new Hono();

// 只读公共服务，放开跨域；要收紧可改成白名单 origins
app.use('*', cors());

const methodNotAllowed = (c) => c.json({ success: false, error: 'Method not allowed' }, 405);

// 兜底：未捕获异常默认 500 纯文本会绕过 cors 中间件（浏览器报成 CORS 错误），
// 这里统一 JSON 信封并手动带上 ACAO，保证任何错误响应前端都能读到 error 文案
app.onError((err, c) => {
    console.error('Unhandled error:', err?.message || err);
    return c.json(
        { success: false, error: err?.message || 'Internal server error' },
        500,
        { 'Access-Control-Allow-Origin': '*' }
    );
});

// 静态元数据接口：浏览器缓存 5 分钟，CDN/边缘可缓存 1 小时（内容随部署更新）
const STATIC_CACHE = 'public, max-age=300, s-maxage=3600';

// 请求级自定义上游 RPC（POST /api/rpc、/api/contract/call、GET /api/call 的 rpc 参数）
// 的实例级开关：公开实例保持关闭防滥用（不被当开放代理）；自建部署在 wrangler.jsonc
// 的 vars 里设 true 放开——任何 EVM 链填上 RPC 即可只读对接
function customRpcAllowed(env) {
    const v = env?.ALLOW_CUSTOM_RPC;
    return v === true || String(v).toLowerCase() === 'true' || String(v) === '1';
}
const CUSTOM_RPC_DISABLED =
    'Custom upstream rpc is disabled on this instance: self-deploy and set ALLOW_CUSTOM_RPC=true (wrangler vars) to enable it.';

// 注册路由并给错误方法返回 405（Hono 默认是 404）
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
        // 只填 rpc 的 overlay 条目（chainId 惰性从上游读）以 chainId: null 列出，
        // 命中一次后（按名称或 rpc 参数）自动补全
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
    const chainId = c.req.query('chainId');
    return c.json({
        success: true,
        addresses: Object.fromEntries(
            Object.entries(addressBook).map(([name, entry]) => [
                name,
                {
                    abi: entry.abi,
                    description: entry.description,
                    address: chainId
                        ? entry.addresses[String(Number(chainId))] || entry.addresses['*'] || null
                        : entry.addresses,
                },
            ])
        ),
    });
});

// GET 版合约读调用：/api/call?chain=1&contract=usdc&fn=balanceOf&p=0x…
// 与 POST /api/contract/call 同一套只读管线（地址簿、ABI、failover），
// 参数用重复的 p 传入并按顺序对应函数入参，方便分享链接和浏览器直接打开。
get('/api/call', async (c) => {
    const chain = c.req.query('chain');
    const customRpc = c.req.query('rpc');
    const contract = c.req.query('contract');
    const fn = c.req.query('fn');
    const params = c.req.queries('p') || [];
    // chain（id 或名称）与 rpc 至少给一个：只有 rpc 时 chainId 从上游 eth_chainId 读
    if (!contract || !fn || (!chain && !customRpc)) {
        return c.json(
            { success: false, error: 'Missing required query parameters: chain (or rpc), contract, fn (params via repeated p=)' },
            400
        );
    }
    // 自定义上游（可选 &rpc=，实例开关放行后生效）：chain 可为白名单外的任意链 ID
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

    // 参数做了简单类型推断：纯数字/true/false/JSON 数组自动转换，其余当字符串
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
    // request 必填；chainId（数字或链名）与 rpc 至少给一个——只有 rpc 时 chainId 从上游读
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
    try {
        const result = await handleRpcRequest(request, chainId, { customRpcUrl: rpc });
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
    // 请求级自定义 ABI（数组或单条 fragment）：带 abi 时无需 contractName，
    // 只读门禁照常生效（view/pure 之外一律 403）
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

    // contractAddress 可以是地址簿名称（如 "multicall3"）；此时 contractName 可省略，
    // 由地址簿条目里的 abi 字段补上
    const resolved = resolveContractAddress(chainId, contractAddress);
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
        const result = await handleContractCall(chainId, finalAddress, finalName, functionName, params, { customRpcUrl: rpc, requestAbi: abi });
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
