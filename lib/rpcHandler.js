/**
 * RPC Handler Module（Cloudflare Workers 环境）
 *
 * - 网络层用原生 fetch（workerd 没有 Node http，axios 跑不了）
 * - 不做前置健康检查：免费版每请求只有 50 个子请求、10ms CPU，
 *   改成"直接请求、失败才切下一个节点"的顺序 failover
 * - JsonRpcProvider 固定 chainId（staticNetwork），省掉每次的 eth_chainId 探测子请求
 * - 方法白名单：本服务只读，广播/签名/重型调试方法一律拒绝
 */

// 具名导入而非 `import { ethers }`：命名空间访问会拖入整个 ethers（bundle 实测
// 985KiB → 显著瘦身），tree-shaking 只保留用到的四个类
import { JsonRpcProvider, FetchRequest, Interface, Contract } from 'ethers';

// Load RPC configuration
import baseChains from './rpcs.json' with { type: 'json' };

// 自定义链 overlay：自部署者加链/换节点用（与 rpcs.json 同 schema，按 chainId 覆盖或追加），
// 不必去改 trim-rpcs 生成的白名单文件
import customChains from './chains.custom.json' with { type: 'json' };

// Load ABI configuration
import abiConfig from './abi.json' with { type: 'json' };

// Load address book（常用合约的"名称 -> 各链地址"映射）
import addressBook from './addresses.json' with { type: 'json' };

/** 带状态码的业务错误（worker 层据此返回 404/403/502 等，而不是一律 500） */
function httpError(status, message) {
    return Object.assign(new Error(message), { status });
}

/**
 * 合并自定义链 overlay：条目只要求 rpc 列表——
 *   带 chainId：按 chainId 覆盖/追加（一等公民，数字可直接命中）；
 *   不带 chainId（最小形态）：进 pendingChains，按名称/短名命中时惰性向上游读 eth_chainId 补全。
 * 条目不合法（rpc 列表为空）的静默跳过，不拖垮整个白名单。
 */
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
// failover 总预算（wall clock）：不设的话最坏 5 节点 × 10s = 50s，客户端早就断开
// 了还在打上游；后备节点的超时随剩余预算递减，耗尽返回 504
const FAILOVER_BUDGET_MS = 15000;
// eth_getLogs 显式数字 block range 上限：公开实例最重的读方法，超限直接 400（零网络）
const GETLOGS_MAX_BLOCK_RANGE = 10000;

/**
 * 按方法分发时，除 switch 里显式解码的方法外，白名单内的方法走原始透传。
 * 只放行读方法；eth_sendTransaction、eth_sign 系列、debug_ 系列等不在名单内即拒绝。
 */
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

/** 判定是否值得换下一个节点重试（网络/限流/节点 5xx），业务 revert 等不算 */
function isRetryableNodeError(error) {
    // rawRpcCall 对上游 HTTP 429/5xx 打的结构化标记：透传路径的重试判定不靠 message 正则碰运气
    if (error?.retryable) return true;
    if (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT') return true;
    // 节点偶发返回空 eth_call 结果（"0x"），view 函数解码必然越界——buffer 为空说明
    // 不是 ABI 不匹配的烂数据，是节点异常，值得换节点（2026-09-17 BSC 实锤一次）
    if (error?.code === 'BUFFER_OVERRUN' && (!error.buffer || error.buffer.length === 0)) return true;
    if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
    const msg = (error.message || '').toLowerCase();
    return /network error|network connection|connection (lost|error|refused|reset|closed)|timeout|timed out|abort|fetch failed|econn|enotfound|eai_again|socket hang up|429|rate limit|limit exceeded|traffic|406|402|502|503|504|server_error|bad_data/.test(msg);
}

// 链名/短名别名（GET /api/call 与 lookupChain 的按名查找用）
const CHAIN_ALIASES = {
    eth: 1, ethereum: 1, bsc: 56, bnb: 56, polygon: 137, matic: 137,
    arbitrum: 42161, arb: 42161, optimism: 10, op: 10, base: 8453,
    avalanche: 43114, avax: 43114, gnosis: 100,
};

/**
 * 纯内存的 chainId 解析（零网络）：数字/数字串原样、链名/短名/别名查表。
 * 解析不了返回 null，交给调用方决定回退语义（如地址簿回退 "*"）。
 */
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

/** 读上游 eth_chainId（按 url 记忆化，实例生命周期只读一次；失败清缓存允许重试） */
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

/** 给缺 chainId 的 overlay 条目（只填 rpc 的最小形态）补 chainId：逐节点尝试，成功即写回条目 */
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

/**
 * 统一找链（三个调用端点共用）。
 * @param {number|string} ref - chainId（数字/数字串）或链名/shortName/别名；带 customRpcUrl 时可省
 * @param {string} [customRpcUrl] - 请求级自定义上游；省略 ref 时 chainId 直接从它读 eth_chainId
 * @returns {Promise<Object>} { chainId, name, rpc }
 * @throws {Error} status=404 找不到；502 上游读不出 chainId
 */
async function lookupChain(ref, customRpcUrl) {
    // 所有端点统一在此校验自定义 rpc url：非法 URL 抛 400，而不是在 customChain
    // 的 new URL() 里炸成 500
    if (customRpcUrl) customRpcUrl = sanitizeCustomRpc(customRpcUrl);
    if (customRpcUrl) {
        const given = ref !== undefined && ref !== null && String(ref).trim() !== '';
        const id = given && /^\d+$/.test(String(ref).trim()) ? Number(ref) : await chainIdFromRpc(customRpcUrl);
        return customChain(id, customRpcUrl);
    }
    const lower = String(ref ?? '').trim().toLowerCase();
    const aliasId = CHAIN_ALIASES[lower];
    const hasRef = ref !== undefined && ref !== null && String(ref).trim() !== '';
    // 数字命中不了 pending 条目（它还没有 chainId 主键）——立即 404，不做网络探测；
    // 名称/短名命中后走惰性补全，补全过一次数字即可命中。
    // 注意 undefined 参与宽松相等会把 aliasId===undefined 变成通配，必须显式判空
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

/**
 * 校验请求级自定义上游 RPC（可选参数 rpc，实例需开 ALLOW_CUSTOM_RPC）。
 * 仅放行 http(s)；返回 null 表示未提供。Workers 无法 fetch 内网地址，
 * 加上实例级开关默认关闭，公开实例不会被当成开放代理滥用。
 */
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

/** 用自定义上游构造单节点链配置：任何 EVM 链填上 rpc 即可只读对接，不受白名单限制 */
function customChain(chainId, rpcUrl) {
    return { chainId: Number(chainId), name: `custom:${new URL(rpcUrl).host}`, rpc: [{ url: rpcUrl }] };
}

/**
 * 原始 JSON-RPC 透传（fetch 版）
 * @param {number} [timeoutMs] - 覆盖默认超时（failover 预算下后备节点递减用）
 * @returns {Promise<any>} result 字段
 * @throws {Error} 上游 HTTP 错误或 JSON-RPC error（429/5xx 带 retryable 标记）
 */
async function rawRpcCall(rpcUrl, rpcRequest, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // 上游要求完整 JSON-RPC 2.0 信封，客户端只传 method/params 时补齐
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
            // JSON-RPC 业务错误（如参数不合法）：换节点也没用，直接抛
            throw Object.assign(new Error(`JSON-RPC error ${data.error.code}: ${data.error.message}`), {
                status: 400,
            });
        }
        return data.result;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Provider 实例：**每请求现建，绝不跨请求缓存**。
 * 曾用模块级 Map 缓存复用——ethers JsonRpcProvider 的内部启动链（_start/boot promise）
 * 会在「创建它的那个请求的上下文」里注册；下一个请求 await 同一实例时，workerd 判定
 * 「跨请求上下文的 promise 续体不安全」直接取消整条请求，报
 * "The Workers runtime canceled this request… code had hung"（冷启动后的并发请求尤甚，
 * 且生产 Cloudflare 上同样存在此风险）。batchMaxCount:1 只修掉了批定时器那一族，
 * 这条是同一类病的最后残留在 2026-09-12 实锤（workerd 警告栈指向 provider-jsonrpc.ts）。
 * 每请求新建的 CPU 开销远小于偶发整请求取消。
 */
function createProvider(rpcUrl, chainId, timeoutMs = REQUEST_TIMEOUT_MS) {
    // 走 FetchRequest 显式设超时：ethers 默认 300s——上游偶发 stalls（连接黑洞不回包）
    // 时 provider.call 永不返回，同样会被 workerd 按挂死取消。10s 与 rawRpcCall 对齐，
    // 超时抛错 → 路由层回 502，前端下一轮轮询重试
    const fetchReq = new FetchRequest(rpcUrl);
    fetchReq.timeout = timeoutMs;
    return new JsonRpcProvider(fetchReq, Number(chainId), {
        staticNetwork: true,
        batchMaxCount: 1,
    });
}

/**
 * 递归把结果里的 BigInt 转成字符串，避免 JSON.stringify 抛
 * "Do not know how to serialize a bigint" 导致接口 500
 */
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

/** block tag（hex/十进制数字）转 number；命名 tag（latest/earliest/pending）返回 null 交上游解释 */
function blockTagToNumber(tag) {
    if (tag === undefined || tag === null) return null;
    const s = String(tag).trim();
    if (/^0x[0-9a-fA-F]+$/.test(s)) {
        try { return Number(BigInt(s)); } catch { return null; }
    }
    if (/^\d+$/.test(s)) return Number(s);
    return null;
}

/**
 * eth_getLogs 显式数字 block range 上限：公开实例最重的读方法，超大范围既拖垮
 * 上游也容易撞 10ms CPU（大响应解码）。超限在发任何上游请求之前 400。
 */
function enforceLogRange(params) {
    const filter = Array.isArray(params) ? params[0] : null;
    if (!filter || typeof filter !== 'object') return;
    const from = blockTagToNumber(filter.fromBlock);
    const to = blockTagToNumber(filter.toBlock);
    if (from !== null && to !== null && to - from > GETLOGS_MAX_BLOCK_RANGE) {
        throw httpError(
            400,
            `eth_getLogs block range too large: ${to - from} blocks (limit ${GETLOGS_MAX_BLOCK_RANGE}). Narrow fromBlock/toBlock, or use a named tag such as "latest".`
        );
    }
}

/**
 * Handle generic RPC requests（只读，白名单内方法）
 * @param {Object} rpcRequest - The RPC request object containing method and params
 * @param {number|string} chainId - The chain ID or network ID to process the request on
 * @param {Object} [opts] - { customRpcUrl?: string } 请求级自定义上游（实例开关放行后生效）
 * @returns {Promise<any>} The result of the RPC call (BigInt-safe)
 */
async function handleRpcRequest(rpcRequest, chainId, opts = {}) {
    // JSON-RPC batch（数组请求）不支持：按单方法做的白名单校验对数组只会误报
    // "Method undefined is not on the allowlist"，这里显式 400 说清楚
    if (Array.isArray(rpcRequest)) {
        throw httpError(400, 'Batch JSON-RPC requests are not supported: send one method per request');
    }
    // chainId 可为数字或链名；带自定义上游时可整个省略（chainId 从上游 eth_chainId 读）
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

    if (method === 'eth_getLogs') enforceLogRange(params);

    // 顺序 failover：rpcs.json 已按节点质量排序，逐个试，成功即返回。
    // 总预算见 FAILOVER_BUDGET_MS：后备节点超时随剩余预算递减，耗尽 504
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
            // 业务错误（revert / 参数错 / JSON-RPC error）换节点无意义，直接抛
            if (!isRetryableNodeError(error)) {
                throw error;
            }
            lastError = error;
            console.warn(`RPC node failed (${url}): ${error.message}, trying next node...`);
        }
    }
    throw httpError(502, `All RPC nodes failed for chain ${chain.name} (${chainId}). Last error: ${lastError?.message}`);
}

/** 单节点执行：fee 三连与白名单透传方法直接 fetch，显式解码的方法走 ethers */
async function dispatchMethod(rpcUrl, chainId, method, params, rpcRequest, timeoutMs = REQUEST_TIMEOUT_MS) {
    // 白名单透传方法直接 fetch 转发，省 CPU
    if (PASSTHROUGH_METHODS.has(method)) {
        return await rawRpcCall(rpcUrl, rpcRequest, timeoutMs);
    }

    // fee 三连单方法直取（hex → bigint，serializeResult 照常输出十进制字符串）。
    // 不走 provider.getFeeData()——那一个方法每次要发 2-3 个上游子请求（gasPrice +
    // blockNumber + priorityFee），拿一个值花三倍免费档配额与延迟；
    // maxPriority/maxFee 不是每个节点都实现，method-not-found 时返回 null（与
    // 旧 getFeeData 语义一致）
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
            // staticNetwork 下不需要子请求，直接从白名单里的 chainId 取
            return BigInt(chainId);

        default:
            return await rawRpcCall(rpcUrl, rpcRequest, timeoutMs);
    }
}

/**
 * 解析合约引用：0x 地址原样返回；否则查地址簿（按 chainId 取，缺省走 "*"）。
 * @param {number|string} chainId
 * @param {string} ref - 0x 地址或地址簿里的名称（如 "multicall3"、"weth"）
 * @returns {Object|null} { address, abi?, description? }，未命中返回 null
 */
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

/**
 * 内置 ABI 的 Interface 缓存：Interface 是纯数据结构，跨请求复用安全（JsonRpcProvider
 * 才有 workerd 跨请求上下文坑，见 createProvider 注释）。请求级 requestAbi 不缓存。
 */
const interfaceCache = new Map();
function getInterface(contractName, requestAbi) {
    if (requestAbi) return new Interface(requestAbi);
    let iface = interfaceCache.get(contractName);
    if (!iface) interfaceCache.set(contractName, (iface = new Interface(abiConfig[contractName])));
    return iface;
}

/**
 * Handle contract function calls (read-only) with failover and BigInt serialization
 * @param {number|string} chainId - The chain ID or network ID
 * @param {string} contractAddress - The address of the contract to call
 * @param {string} contractName - The name of the contract (must match ABI configuration)
 * @param {string} functionName - The name of the function to call
 * @param {Array} params - Array of parameters for the function call
 * @param {Object} [opts] - { customRpcUrl?: string, requestAbi?: Array } 请求级自定义上游/ABI
 * @returns {Promise<any>} The result of the contract call with BigInt serialized
 */
async function handleContractCall(chainId, contractAddress, contractName, functionName, params = [], opts = {}) {
    // 只收 0x 地址：非 0x target 会被 ethers 当 ENS 域名解析，在非主网链上等于
    // 白白多发 eth_call 子请求再拿到空结果。地址簿名称由 worker 层 resolve 后传入。
    if (typeof contractAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(contractAddress)) {
        throw httpError(400, `contractAddress must be a 0x address (address-book names are resolved by the HTTP layer): ${contractAddress}`);
    }

    const chain = await lookupChain(chainId, opts.customRpcUrl);

    // 请求级自定义 ABI 优先（数组或单条 fragment）；否则回落内置 abiConfig[contractName]
    const contractAbi = opts.requestAbi ?? abiConfig[contractName];
    if (!contractAbi) {
        throw httpError(404, `ABI configuration not found for contract ${contractName} (or pass a request-level "abi")`);
    }

    if (functionName === 'constructor') {
        throw httpError(400, 'Cannot directly call constructor');
    }

    // ethers v6 的 getFunction 找不到时直接抛错，这里统一转成 404
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

    // 本服务定位只读：仅放行 view/pure，写操作一律拒绝
    // （签名与广播由客户端钱包完成，服务端绝不接触私钥）
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
            // Interface 实例跨节点复用（解析一次），每节点只重建轻量的 Contract 壳与 provider
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

/**
 * Get list of supported contracts from ABI configuration
 * @returns {Array<string>} Array of contract names
 */
function getSupportedContracts() {
    return Object.keys(abiConfig);
}

/**
 * Get list of functions for a specific contract
 * @param {string} contractName - The name of the contract
 * @returns {Array<Object>} Array of function objects with metadata
 */
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

// Export（abiConfig 仅模块内部使用，不对外导出）
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
