
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 60;

export function clientKey(request) {
    const cf = request.headers.get('cf-connecting-ip');
    if (cf) return cf.trim();
    const xff = request.headers.get('x-forwarded-for');
    if (xff) return xff.split(',')[0].trim();
    return 'local';
}

export function createRateLimiter({ limit = DEFAULT_LIMIT, windowMs = DEFAULT_WINDOW_MS, now = Date.now } = {}) {
    const buckets = new Map();

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
            const oldest = store.keys().next().value;
            if (oldest !== undefined) store.delete(oldest);
        }
        store.set(key, { value, expiresAt: now() + ttlMs });
    }

    return { get, set, clear: () => store.clear(), get size() { return store.size; } };
}

export const CACHEABLE_RPC_METHODS = new Set([
    'eth_blockNumber',
    'eth_chainId',
    'eth_gasPrice',
    'eth_maxPriorityFeePerGas',
    'eth_syncing',
    'net_version',
]);
