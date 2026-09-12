/**
 * 只读安全与路由行为测试（零网络：全部断言都发生在任何上游 RPC 请求之前）
 * 运行：npm test（node --test）
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import app from '../src/worker.js';
import {
    rpcConfig,
    pendingChains,
    lookupChain,
    addressBook,
    resolveContractAddress,
    handleRpcRequest,
    handleContractCall,
    getSupportedContracts,
    getContractFunctions,
} from '../lib/rpcHandler.js';

/** 业务错误带 status，直接断言它 */
async function expectStatus(promise, status, messagePart) {
    const error = await promise.then(
        () => assert.fail('expected the call to throw'),
        (e) => e
    );
    assert.equal(error.status, status, `expected status ${status}, got ${error.status}: ${error.message}`);
    if (messagePart) assert.match(error.message, messagePart);
    return error;
}

// ---------- 只读红线：写/签名方法必须 403 ----------

test('eth_sendRawTransaction is rejected with 403', async () => {
    await expectStatus(
        handleRpcRequest({ method: 'eth_sendRawTransaction', params: ['0xdeadbeef'] }, 1),
        403, /read-only/
    );
});

test('eth_sendTransaction / eth_sign / eth_signTypedData_v4 are rejected with 403', async () => {
    for (const method of ['eth_sendTransaction', 'eth_sign', 'eth_signTypedData_v4']) {
        await expectStatus(handleRpcRequest({ method, params: [] }, 1), 403, /read-only/);
    }
});

test('methods outside the allowlist (debug_*, trace_*) are rejected with 403', async () => {
    await expectStatus(handleRpcRequest({ method: 'debug_traceTransaction', params: [] }, 1), 403, /allowlist/);
    await expectStatus(handleRpcRequest({ method: 'trace_block', params: [] }, 1), 403, /allowlist/);
});

test('write functions in ABIs (transfer/approve/constructor) are rejected with 403/400', async () => {
    await expectStatus(
        handleContractCall(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'token', 'transfer', ['0x0000000000000000000000000000000000000001', 1]),
        403, /read-only/
    );
    await expectStatus(
        handleContractCall(1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'token', 'constructor', []),
        400
    );
});

// ---------- 配置完整性 ----------

test('chain config: every entry has rpc urls; only fully-configured entries need chainId', () => {
    const all = [...rpcConfig, ...pendingChains];
    assert.ok(all.length >= 20, `expected 20+ chains, got ${all.length}`);
    for (const chain of all) {
        assert.ok(chain.rpc?.length >= 1, `chain ${chain.name} has no rpc nodes`);
        for (const node of chain.rpc) assert.ok(/^https?:\/\//.test(node.url), `bad rpc url in ${chain.name}`);
    }
    for (const chain of rpcConfig) {
        assert.ok(chain.chainId, `resolved chain ${chain.name} missing chainId`);
    }
    // 只填 rpc 的 pending 条目至少要能被名称/短名命中（否则永远无法触发 chainId 补全）
    for (const chain of pendingChains) {
        assert.ok(chain.name || chain.shortName, 'pending overlay entry needs a name or shortName for lookup');
    }
    const ids = rpcConfig.map((c) => c.chainId);
    assert.equal(new Set(ids).size, ids.length, 'duplicate chainId in whitelist');
});

test('unknown chain id / name is rejected with 404 before any network call', async () => {
    await expectStatus(handleRpcRequest({ method: 'eth_blockNumber', params: [] }, 999999), 404);
});

test('address book entries resolve per-chain and fall back to "*"', () => {
    const usdc = resolveContractAddress(1, 'usdc');
    assert.equal(usdc.abi, 'token');
    assert.match(usdc.address, /^0x[0-9a-fA-F]{40}$/);
    // 未配置该链时回退到通配地址（如 multicall3）
    const mc = resolveContractAddress(1, 'multicall3');
    assert.ok(mc && mc.address, 'multicall3 should resolve on chain 1');
    // 0x 原样透传，未知名称返回 null
    assert.deepEqual(resolveContractAddress(1, '0x1111111111111111111111111111111111111111').address, '0x1111111111111111111111111111111111111111');
    assert.equal(resolveContractAddress(1, 'not-a-thing'), null);
});

test('ABI catalog lists the standard token functions with stateMutability metadata', () => {
    const contracts = getSupportedContracts();
    assert.ok(contracts.length >= 9, `expected 9+ contracts, got ${contracts.length}`);
    const token = getContractFunctions('token');
    const names = token.map((f) => f.name);
    assert.ok(names.includes('balanceOf') && names.includes('decimals') && names.includes('totalSupply'));
    const balanceOf = token.find((f) => f.name === 'balanceOf');
    assert.equal(balanceOf.stateMutability, 'view');
    assert.deepEqual(getContractFunctions('no-such-contract'), []);
});

// ---------- HTTP 层（Hono app.request，同样零网络）----------

test('GET /api/health returns 200 ok', async () => {
    const res = await app.request('/api/health');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
});

test('GET /api/chains returns the whitelist plus pending overlay entries', async () => {
    const res = await app.request('/api/chains');
    assert.equal(res.status, 200);
    const { chains } = await res.json();
    assert.ok(chains.length >= 20);
    assert.ok(chains.some((c) => c.chainId === 1), 'ethereum mainnet missing');
    // 只填 rpc 的 overlay 条目以 chainId: null 列出（命中一次后自动补全）
    assert.ok(chains.some((c) => c.chainId === null && c.rpcUrls.some((u) => u.includes('127.0.0.1'))));
});

test('wrong HTTP method on read endpoints returns 405', async () => {
    assert.equal((await app.request('/api/health', { method: 'POST' })).status, 405);
    assert.equal((await app.request('/api/rpc', { method: 'GET' })).status, 405);
});

test('GET /api/call validates params: 400 missing, 404 unknown chain', async () => {
    assert.equal((await app.request('/api/call')).status, 400);
    assert.equal((await app.request('/api/call?chain=1&contract=usdc')).status, 400);
    const res = await app.request('/api/call?chain=999999&contract=usdc&fn=balanceOf&p=0x1111111111111111111111111111111111111111');
    assert.equal(res.status, 404);
});

test('POST /api/contract/call write function surfaces 403 through the HTTP layer', async () => {
    const res = await app.request('/api/contract/call', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chainId: 1,
            contractAddress: 'usdc',
            functionName: 'transfer',
            params: ['0x1111111111111111111111111111111111111111', 1],
        }),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.error, /read-only/);
});

test('unknown contract / function references return 404', async () => {
    const res = await app.request('/api/contracts/nope/functions');
    assert.equal(res.status, 404);
    const res2 = await app.request(
        '/api/call?chain=1&contract=usdc&fn=noSuchFunction&p=0x1111111111111111111111111111111111111111'
    );
    assert.equal(res2.status, 404);
});

// ---------- 自定义链 overlay 与请求级自定义上游 RPC ----------

test('chains.custom.json overlay: minimal (rpc-only) entries land in pendingChains', () => {
    assert.ok(pendingChains.length >= 1, `expected pending overlay entries, got ${pendingChains.length}`);
    const urls = pendingChains.flatMap((c) => (c.rpc || []).map((r) => r.url));
    assert.ok(urls.some((u) => u.includes('127.0.0.1:8545')), 'hardhat-local pending entry missing');
    // pending 条目没有 chainId 主键：数字查找立即 404（零网络），名称命中才触发惰性补全
    assert.ok(pendingChains.every((c) => !c.chainId), 'pending entries must not carry a pre-set chainId');
});

test('lookupChain rejects unknown ids/names with 404 before any network call', async () => {
    await expectStatus(lookupChain('no-such-chain'), 404, /Unknown chain/);
    await expectStatus(lookupChain(999999), 404);
});

test('imputations address book entry resolves per-chain without wildcard fallback', () => {
    assert.equal(addressBook.imputations.abi, 'Imputations');
    const local = resolveContractAddress(31337, 'imputations');
    assert.match(local.address, /^0x[0-9a-fA-F]{40}$/);
    // 未配置的链不能误回退到别的链地址
    assert.equal(resolveContractAddress(56, 'imputations'), null);
    assert.equal(resolveContractAddress(7156777, 'imputations'), null);
});

test('request-level custom rpc is rejected with 403 when the instance gate is off', async () => {
    for (const path of [
        '/api/rpc',
        '/api/call?chain=1&contract=usdc&fn=balanceOf&p=0x1111111111111111111111111111111111111111&rpc=https://my-own-node.example',
    ]) {
        const res = await app.request(path, {
            method: path === '/api/rpc' ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json' },
            ...(path === '/api/rpc'
                ? { body: JSON.stringify({ chainId: 1, rpc: 'https://my-own-node.example', request: { method: 'eth_blockNumber', params: [] } }) }
                : {}),
        });
        assert.equal(res.status, 403, path);
        assert.match((await res.json()).error, /ALLOW_CUSTOM_RPC/);
    }
    // 省略 chainId、只带 rpc 的请求同样先过门禁（chainId 从上游读发生在门禁之后）
    const res = await app.request('/api/rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rpc: 'https://my-own-node.example', request: { method: 'eth_blockNumber', params: [] } }),
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /ALLOW_CUSTOM_RPC/);
});

test('custom rpc url must be http(s): 400 even when the gate is on', async () => {
    const res = await app.request(
        '/api/rpc',
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chainId: 1, rpc: 'ftp://nope.example', request: { method: 'eth_blockNumber', params: [] } }),
        },
        { ALLOW_CUSTOM_RPC: 'true' }
    );
    assert.equal(res.status, 400);
});

test('custom rpc keeps the read-only gates and skips the chain whitelist (zero network)', async () => {
    // 白名单外的 chainId 不再 404，但写方法/白名单外方法/view 函数门禁照常，
    // 且这些校验都发生在任何上游请求之前（零网络可测）
    await expectStatus(
        handleRpcRequest({ method: 'eth_sendRawTransaction', params: ['0xdeadbeef'] }, 999999, { customRpcUrl: 'https://my-own-node.example' }),
        403, /read-only/
    );
    await expectStatus(
        handleRpcRequest({ method: 'debug_traceTransaction', params: [] }, 999999, { customRpcUrl: 'https://my-own-node.example' }),
        403, /allowlist/
    );
    await expectStatus(
        handleRpcRequest({ method: 'eth_blockNumber', params: [] }, 1, { customRpcUrl: 'ftp://nope.example' }),
        400, /http\(s\)/
    );
    await expectStatus(
        handleContractCall(
            999999, '0x1111111111111111111111111111111111111111', 'token', 'transfer',
            ['0x1111111111111111111111111111111111111111', 1], { customRpcUrl: 'https://my-own-node.example' }
        ),
        403, /read-only/
    );
});
