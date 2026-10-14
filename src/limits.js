/**
 * 轻量防护工具：IP 限速 + 热点 RPC 短缓存（审计 06 档 F-016）。
 *
 * 背景：公开只读实例可被脚本蹭用（上游免费额度 / Workers CPU 时长）。这里在
 * worker HTTP 层加两道门，均不引入 KV / D1，纯 isolate 内存态。
 *
 * 内存态语义（务必知悉）：Cloudflare Workers 每个 isolate 各持一份 Map，计数不跨
 * isolate / PoP 共享，isolate 亦会随时回收——限速是「单 isolate 内的宽松漏斗」，
 * 目的是抬高脚本蹭用成本，不是精确配额。需要全局精确配额须接 D1 / Durable Object，
 * 属可选强化（不在本次范围）。
 */

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 60;

/** 取客户端 IP：CF 边缘头优先；本地 dev / 测试无该头时回退占位键（同键共享额度）。 */
export function clientKey(request) {
    const cf = request.headers.get('cf-connecting-ip');
    if (cf) return cf.trim();
    const xff = request.headers.get('x-forwarded-for');
    if (xff) return xff.split(',')[0].trim();
    return 'local';
}

/**
 * 固定窗口计数器。
 * check(key) → { allowed, remaining, retryAfter }（retryAfter 单位秒）。
 */
export function createRateLimiter({ limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
    const buckets = new Map();

    // 无界增长护栏：仅在桶数量偏大时按过期扫描一次，避免每个 IP 一个键累积
    function sweep(t) {
        if (buckets.size < 10_000) return;
        for (const [k, b] of buckets) if (t >= b.resetAt) buckets.delete(k);
    }

    function check(key) {
        const t = now();
        sweep(t);
        let b = buckets.get(key);
        if (!b || t >= b.resetAt) {
            b = { count: 0, resetAt: t + windowMs };
            buckets.set(key, b);
        }
        b.count += 1;
        return {
            allowed: b.count <= limit,
            remaining: Math.max(0, limit - b.count),
            retryAfter: Math.max(1, Math.ceil((b.resetAt - t) / 1000)),
        };
    }

    return { check, reset: () => buckets.clear() };
}

/**
 * 极短 TTL 的内存缓存（热点只读方法）。
 * get 命中且未过期返回 value，否则 undefined。
 */
export function createShortCache({ ttlMs = 5000, max = 500, now = Date.now } = {}) {
    const store = new Map();

    function get(key) {
        const hit = store.get(key);
        if (!hit) return undefined;
        if (now() >= hit.expiresAt) { store.delete(key); return undefined; }
        return hit.value;
    }

    function set(key, value) {
        if (store.size >= max && !store.has(key)) {
            // 简单淘汰：删最早插入的一条（Map 迭代序即插入序）
            const oldest = store.keys().next().value;
            if (oldest !== undefined) store.delete(oldest);
        }
        store.set(key, { value, expiresAt: now() + ttlMs });
    }

    return { get, set, clear: () => store.clear(), get size() { return store.size; } };
}

/** 可短缓存的热点方法：无参数 + 5s 内语义稳定的链状态读。 */
export const CACHEABLE_RPC_METHODS = new Set([
    'eth_blockNumber',
    'eth_chainId',
    'eth_gasPrice',
    'eth_maxPriorityFeePerGas',
    'eth_syncing',
    'net_version',
]);
