
import { JsonRpcProvider, FetchRequest, Interface, Contract } from 'ethers';

import baseChains from './rpcs.json' with { type: 'json' };

import customChains from './chains.custom.json' with { type: 'json' };

import abiConfig from './abi.json' with { type: 'json' };

import addressBook from './addresses.json' with { type: 'json' };

function httpError(status, message) {
    return Object.assign(new Error(message), { status });
}

function splitChains(base, custom) {
    const byId = new Map(base.map((c) => [Number(c.chainId), c]));
    const pending = [];
    for (const c of custom ?? []) {
        if (!Array.isArray(c?.rpc) || c.rpc.length === 0) continue;
        if (c.chainId) byId.set(Number(c.chainId), { ...c, chainId: Number(c.chainId) });
        else pending.push({ ...c });
    }
    return { merged: [...byId.values()], pending };
}

const { merged: rpcConfig, pending: pendingChains } = splitChains(baseChains, customChains);

const REQUEST_TIMEOUT_MS = 10000;
const FAILOVER_BUDGET_MS = 15000;
const GETLOGS_MAX_BLOCK_RANGE = 10000;

const PASSTHROUGH_METHODS = new Set([
    'eth_getBlockTransactionCountByHash',
    'eth_getBlockTransactionCountByNumber',
    'eth_getBlockReceipts',
    'eth_getTransactionByBlockHashAndIndex',
    'eth_getTransactionByBlockNumberAndIndex',
    'eth_feeHistory',
    'eth_blobBaseFee',
    'eth_syncing',
    'web3_clientVersion',
    'net_listening',
    'net_peerCount',
]);

function isRetryableNodeError(error) {
    if (error?.retryable) return true;
    if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') return true;
    if (error?.code === 'BUFFER_OVERRUN' && (!error.buffer || error.buffer.length === 0)) return true;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    const msg = (error.message || '').toLowerCase();
    return /network error|network connection|connection (lost|error|refused|reset|closed)|timeout|timed out|abort|fetch failed|econn|enotfound|eai_again|socket hang up|429|rate limit|limit exceeded|traffic|406|402|502|503|504|server_error|bad_data/.test(msg);
}

const CHAIN_ALIASES = {
    eth: 1, ethereum: 1, bsc: 56, bnb: 56, polygon: 137, matic: 137,
    arbitrum: 42161, arb: 42161, optimism: 10, op: 10, base: 8453,
    avalanche: 43114, avax: 43114, gnosis: 100,
};

function parseChainRef(ref) {
    if (ref === undefined || ref === null || String(ref).trim() === '') return null;
    const s = String(ref).trim();
    if (/^\d+$/.test(s)) return Number(s);
    const lower = s.toLowerCase();
    if (CHAIN_ALIASES[lower] !== undefined) return CHAIN_ALIASES[lower];
    const hit = rpcConfig.find(
        (c) => (c.name || '').toLowerCase() === lower || (c.shortName || '').toLowerCase() === lower
    );
    return hit?.chainId ?? null;
}

const chainIdByUrl = new Map();
function chainIdFromRpc(rpcUrl) {
    if (!chainIdByUrl.has(rpcUrl)) {
        chainIdByUrl.set(
            rpcUrl,
            rawRpcCall(rpcUrl, { method: 'eth_chainId', params: [] })
                .then((hex) => Number(BigInt(hex)))
                .catch((e) => {
                    chainIdByUrl.delete(rpcUrl);
                    throw e;
                })
        );
    }
    return chainIdByUrl.get(rpcUrl);
}

async function ensureChainIdOf(entry) {
    if (entry.chainId) return entry.chainId;
    let lastError = null;
    for (const { url } of entry.rpc) {
        try {
            entry.chainId = await chainIdFromRpc(url);
            return entry.chainId;
        } catch (e) {
            lastError = e;
        }
    }
    throw httpError(502, `Cannot resolve chainId via eth_chainId for "${entry.name || 'unnamed'}": ${lastError?.message}`);
}

async function lookupChain(ref, customRpcUrl) {
    if (customRpcUrl) customRpcUrl = sanitizeCustomRpc(customRpcUrl);
    if (customRpcUrl) {
        const given = ref !== undefined && ref !== null && String(ref).trim() !== '';
        const id = given && /^\d+$/.test(String(ref).trim()) ? Number(ref) : await chainIdFromRpc(customRpcUrl);
        return customChain(id, customRpcUrl);
    }
    const lower = String(ref ?? '').trim().toLowerCase();
    const aliasId = CHAIN_ALIASES[lower];
    const hasRef = ref !== undefined && ref !== null && String(ref).trim() !== '';
    const chain = [...rpcConfig, ...pendingChains].find((c) => {
        if (hasRef && c.chainId !== undefined && c.chainId !== null && (c.chainId == ref || (aliasId !== undefined && c.chainId == aliasId))) return true;
        if (lower !== '' && ((c.name || '').toLowerCase() === lower || (c.shortName || '').toLowerCase() === lower)) return true;
        return false;
    });
    if (!chain) {
        throw httpError(404, `Unknown chain: ${ref}. Add it to lib/chains.custom.json (with chainId or a name), or pass an "rpc" url directly.`);
    }
    if (!chain.chainId) await ensureChainIdOf(chain);
    return chain;
}

function sanitizeCustomRpc(url) {
    if (!url) return null;
    let parsed;
    try {
        parsed = new URL(String(url));
    } catch {
        throw httpError(400, `Invalid custom rpc url: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw httpError(400, `Custom rpc url must be http(s), got: ${parsed.protocol}`);
    }
    return parsed.toString();
}

function customChain(chainId, rpcUrl) {
    return { chainId: Number(chainId), name: `custom:${new URL(rpcUrl).host}`, rpc: [{ url: rpcUrl }] };
}

async function rawRpcCall(rpcUrl, rpcRequest, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const body = {
        jsonrpc: '2.0',
        id: rpcRequest.id ?? 1,
        method: rpcRequest.method,
        params: rpcRequest.params || [],
    };
    try {
        const response = await fetch(rpcUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'User-Agent': 'Stapleport/1.0',
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) {
            const err = new Error(`upstream HTTP ${response.status} from ${new URL(rpcUrl).host}`);
            if (response.status === 429 || response.status >= 500) err.retryable = true;
            throw err;
        }
        const data = await response.json();
        if (data.error) {
            throw Object.assign(new Error(`JSON-RPC error ${data.error.code}: ${data.error.message}`), {
                status: 400,
            });
        }
        return data.result;
    } finally {
        clearTimeout(timer);
    }
}

function createProvider(rpcUrl, chainId, timeoutMs = REQUEST_TIMEOUT_MS) {
    const fetchReq = new FetchRequest(rpcUrl);
    fetchReq.timeout = timeoutMs;
    return new JsonRpcProvider(fetchReq, Number(chainId), {
        staticNetwork: true,
        batchMaxCount: 1,
    });
}

function serializeResult(value) {
    if (typeof value === 'bigint') {
        return value.toString();
    } else if (Array.isArray(value)) {
        return value.map(item => serializeResult(item));
    } else if (value && typeof value === 'object') {
        const processed = {};
        for (const key in value) {
            processed[key] = serializeResult(value[key]);
        }
        return processed;
    }
    return value;
}

function blockTagToNumber(tag) {
    if (tag === undefined || tag === null) return null;
    const s = String(tag).trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) {
        try { return Number(BigInt(s)); } catch { return null; }
    }
    if (/^\d+$/.test(s)) return Number(s);
    return null;
}

async function fetchLatestBlockNumber(chain, chainId) {
    let lastError = null;
    for (const { url } of chain.rpc) {
        try {
            const raw = await rawRpcCall(url, { method: 'eth_blockNumber', params: [] });
            const n = Number(BigInt(raw));
            if (Number.isSafeInteger(n) && n >= 0) return n;
            lastError = new Error(`unparsable eth_blockNumber result: ${raw}`);
        } catch (error) {
            lastError = error;
        }
    }
    throw httpError(
        400,
        `eth_getLogs block range cannot be bounded: failed to resolve the latest block via eth_blockNumber for chain ${chain.name} (${chainId}). Last error: ${lastError?.message}`
    );
}

async function enforceLogRange(params, chain, chainId) {
    const filter = Array.isArray(params) ? params[0] : null;
    if (!filter || typeof filter !== 'object') return;
    let from = blockTagToNumber(filter.fromBlock);
    let to = blockTagToNumber(filter.toBlock);
    if (from === null || to === null) {
        const rawFrom = filter.fromBlock === undefined || filter.fromBlock === null
            ? ''
            : String(filter.fromBlock).trim().toLowerCase();
        if (from === null && rawFrom === 'earliest') {
            from = 0;
        }
        if (from === null || to === null) {
            const latest = await fetchLatestBlockNumber(chain, chainId);
            if (from === null) from = latest;
            if (to === null) to = latest;
        }
    }
    if (to - from > GETLOGS_MAX_BLOCK_RANGE) {
        throw httpError(
            400,
            `eth_getLogs block range too large: ${to - from} blocks (limit ${GETLOGS_MAX_BLOCK_RANGE}). Narrow fromBlock/toBlock, or use a named tag such as "latest".`
        );
    }
}

async function handleRpcRequest(rpcRequest, chainId, opts = {}) {
    if (Array.isArray(rpcRequest)) {
        throw httpError(400, 'Batch JSON-RPC requests are not supported: send one method per request');
    }
    const chain = await lookupChain(chainId, opts.customRpcUrl);
    const { method, params = [] } = rpcRequest || {};

    if (method === 'eth_sendRawTransaction' || method === 'eth_sendTransaction' ||
        method === 'eth_signTransaction' || method === 'eth_sign' || method === 'eth_signTypedData_v4') {
        throw httpError(403, `This proxy is read-only: ${method} is not supported. Sign and broadcast from a client-side wallet instead.`);
    }

    const knownMethods = [
        'eth_blockNumber', 'eth_getBalance', 'eth_getTransactionCount',
        'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_getTransactionByHash',
        'eth_getTransactionReceipt', 'eth_call', 'eth_estimateGas', 'eth_getCode',
        'eth_getStorageAt', 'eth_getLogs', 'eth_chainId', 'net_version',
        'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_maxFeePerGas',
    ];
    if (!knownMethods.includes(method) && !PASSTHROUGH_METHODS.has(method)) {
        throw httpError(403, `Method ${method} is not on the read-only allowlist of this proxy.`);
    }

    if (method === 'eth_getLogs') await enforceLogRange(params, chain, chainId);

    let lastError = null;
    const startedAt = Date.now();
    for (const { url } of chain.rpc) {
        const elapsed = Date.now() - startedAt;
        if (elapsed > FAILOVER_BUDGET_MS) {
            throw httpError(504, `Upstream failover budget of ${FAILOVER_BUDGET_MS / 1000}s exhausted for chain ${chain.name} (${chainId}). Last error: ${lastError?.message}`);
        }
        const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, FAILOVER_BUDGET_MS - elapsed);
        try {
            return serializeResult(await dispatchMethod(url, chain.chainId, method, params, rpcRequest, timeoutMs));
        } catch (error) {
            if (!isRetryableNodeError(error)) {
                throw error;
            }
            lastError = error;
            console.warn(`RPC node failed (${url}): ${error.message}, trying next node...`);
        }
    }
    throw httpError(502, `All RPC nodes failed for chain ${chain.name} (${chainId}). Last error: ${lastError?.message}`);
}

async function dispatchMethod(rpcUrl, chainId, method, params, rpcRequest, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (PASSTHROUGH_METHODS.has(method)) {
        return await rawRpcCall(rpcUrl, rpcRequest, timeoutMs);
    }

    switch (method) {
        case 'eth_gasPrice':
            return BigInt(await rawRpcCall(rpcUrl, rpcRequest, timeoutMs));
        case 'eth_maxPriorityFeePerGas':
        case 'eth_maxFeePerGas':
            try {
                return BigInt(await rawRpcCall(rpcUrl, rpcRequest, timeoutMs));
            } catch (error) {
                if (/-32601|method not found/i.test(error.message || '')) return null;
                throw error;
            }
    }

    const provider = createProvider(rpcUrl, chainId, timeoutMs);
    switch (method) {
        case 'eth_blockNumber':
            return await provider.getBlockNumber();

        case 'eth_getBalance':
            return await provider.getBalance(params[0], params[1]);

        case 'eth_getTransactionCount':
            return await provider.getTransactionCount(params[0], params[1]);

        case 'eth_getBlockByNumber':
        case 'eth_getBlockByHash':
            return await provider.getBlock(params[0], params[1]);

        case 'eth_getTransactionByHash':
            return await provider.getTransaction(params[0]);

        case 'eth_getTransactionReceipt':
            return await provider.getTransactionReceipt(params[0]);

        case 'eth_call':
            return await provider.call(params[0], params[1]);

        case 'eth_estimateGas':
            return await provider.estimateGas(params[0]);

        case 'eth_getCode':
            return await provider.getCode(params[0], params[1]);

        case 'eth_getStorageAt':
            return await provider.getStorage(params[0], params[1]);

        case 'eth_getLogs':
            return await provider.getLogs(params[0]);

        case 'eth_chainId':
        case 'net_version':
            return BigInt(chainId);

        default:
            return await rawRpcCall(rpcUrl, rpcRequest, timeoutMs);
    }
}

function resolveContractAddress(chainId, ref) {
    if (typeof ref !== 'string' || /^0x[0-9a-fA-F]{40}$/.test(ref)) {
        return ref ? { address: ref } : null;
    }
    const entry = addressBook[ref] || addressBook[ref.toLowerCase()];
    if (!entry) return null;
    const address = entry.addresses[String(Number(chainId))] || entry.addresses['*'];
    if (!address) return null;
    return { address, abi: entry.abi, description: entry.description };
}

const interfaceCache = new Map();
function getInterface(contractName, requestAbi) {
    if (requestAbi) return new Interface(requestAbi);
    let iface = interfaceCache.get(contractName);
    if (!iface) interfaceCache.set(contractName, (iface = new Interface(abiConfig[contractName])));
    return iface;
}

async function handleContractCall(chainId, contractAddress, contractName, functionName, params = [], opts = {}) {
    if (typeof contractAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) {
        throw httpError(400, `contractAddress must be a 0x address (address-book names are resolved by the HTTP layer): ${contractAddress}`);
    }

    const chain = await lookupChain(chainId, opts.customRpcUrl);

    const contractAbi = opts.requestAbi ?? abiConfig[contractName];
    if (!contractAbi) {
        throw httpError(404, `ABI configuration not found for contract ${contractName} (or pass a request-level "abi")`);
    }

    if (functionName === 'constructor') {
        throw httpError(400, 'Cannot directly call constructor');
    }

    const iface = getInterface(contractName, opts.requestAbi);
    let functionFragment;
    try {
        functionFragment = iface.getFunction(functionName);
    } catch {
        throw httpError(404, `Function ${functionName} does not exist in contract ${contractName}`);
    }
    if (!functionFragment) {
        throw httpError(404, `Function ${functionName} does not exist in contract ${contractName}`);
    }

    if (functionFragment.stateMutability !== 'view' && functionFragment.stateMutability !== 'pure') {
        throw httpError(403, `This proxy is read-only: ${functionName} is a write operation. Sign and broadcast from a client-side wallet instead.`);
    }

    let lastError = null;
    const startedAt = Date.now();
    for (const { url } of chain.rpc) {
        const elapsed = Date.now() - startedAt;
        if (elapsed > FAILOVER_BUDGET_MS) {
            throw httpError(504, `Upstream failover budget of ${FAILOVER_BUDGET_MS / 1000}s exhausted for chain ${chain.name} (${chainId}). Last error: ${lastError?.message}`);
        }
        const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, FAILOVER_BUDGET_MS - elapsed);
        try {
            const contract = new Contract(contractAddress, iface, createProvider(url, chain.chainId, timeoutMs));
            const result = await contract[functionName](...params);
            return serializeResult(result);
        } catch (error) {
            if (!isRetryableNodeError(error)) {
                throw error;
            }
            lastError = error;
            console.warn(`Contract call node failed (${url}): ${error.message}, trying next node...`);
        }
    }
    throw httpError(502, `All RPC nodes failed for chain ${chain.name} (${chainId}). Last error: ${lastError?.message}`);
}

function getSupportedContracts() {
    return Object.keys(abiConfig);
}

function getContractFunctions(contractName) {
    const contractAbi = abiConfig[contractName];
    if (!contractAbi) {
        return [];
    }

    return contractAbi
        .filter(item => item.type === 'function')
        .map(item => ({
            name: item.name,
            inputs: item.inputs,
            outputs: item.outputs,
            stateMutability: item.stateMutability
        }));
}

export {
    rpcConfig,
    pendingChains,
    lookupChain,
    parseChainRef,
    addressBook,
    resolveContractAddress,
    isRetryableNodeError,
    handleRpcRequest,
    handleContractCall,
    getSupportedContracts,
    getContractFunctions
};
