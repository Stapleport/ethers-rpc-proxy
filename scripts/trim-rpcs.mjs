#!/usr/bin/env node
/**
 * 把 chainlist 全量数据裁剪成部署白名单（Cloudflare Workers 免费版有脚本体积和
 * 每请求 10ms CPU 限制，2MB/2317 链的全量 JSON 打进 bundle 会拖垮冷启动）。
 *
 * 用法（在 ethers_next 目录执行）：
 *   node scripts/trim-rpcs.mjs                # 裁剪 lib/rpcs.json
 *   node scripts/trim-rpcs.mjs --input xx.json # 从别的 chainlist 全量文件裁
 *
 * 数据来源：https://chainlist.network 的 chainlist 导出（chainId 为准）。
 * 要加链：在 MAINNETS/TESTNETS 里补 chainId，重跑本脚本。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 常用主网（收款场景优先 BSC/ETH，其余为用户常用 L1/L2）
const MAINNETS = [
    1, // Ethereum
    10, // Optimism
    25, // Cronos
    56, // BNB Smart Chain
    100, // Gnosis
    137, // Polygon
    204, // opBNB
    250, // Fantom
    324, // zkSync Era
    8453, // Base
    42161, // Arbitrum One
    43114, // Avalanche C-Chain
    5000, // Mantle
    59144, // Linea
    534352, // Scroll
];
// 对应测试网
const TESTNETS = [
    97, // BSC Testnet
    80002, // Polygon Amoy
    84532, // Base Sepolia
    421614, // Arbitrum Sepolia
    11155111, // Ethereum Sepolia
    11155420, // OP Sepolia
];
const WHITELIST = new Set([...MAINNETS, ...TESTNETS]);

// 公共节点按质量排序的偏好（越靠前越优先作为 failover 首选）
const RPC_PREFERENCE = [
    /bnbchain\.org|bsc-dataseed/i,
    /publicnode\.com/i,
    /llamarpc\.com/i,
    /1rpc\.io/i,
    /blastapi\.io/i,
    /nodies\.app/i,
    /ankr\.com|rpc\.ankr\.com/i,
    /drpc\.org/i,
    /arbitrum\.io\/rpc|arb1\.arbitrum\.io/i,
    /mainnet\.base\.org|sepolia\.base\.org/i,
    /ethereum-rpc\.publicnode|ethereum\.publicnode/i,
    /polygon-rpc\.com/i,
    /avax-network\.ext\.chainnode|avalanche/i,
];

const inputIdx = process.argv.indexOf('--input');
const inputFile = inputIdx !== -1 ? process.argv[inputIdx + 1] : path.join(ROOT, 'lib', 'rpcs.json');
const source = JSON.parse(readFileSync(inputFile, 'utf8'));

const kept = [];
const missing = [];
for (const chainId of [...MAINNETS, ...TESTNETS]) {
    const chain = source.find((c) => c.chainId === chainId);
    if (!chain) {
        missing.push(chainId);
        continue;
    }

    // 只要 https 公共端点，去重，按偏好排序后截前 5 个做 failover 列表
    const seen = new Set();
    const urls = chain.rpc
        .map((r) => (typeof r === 'string' ? r : r.url))
        .filter((u) => u.startsWith('https://') && !seen.has(u) && seen.add(u));
    urls.sort((a, b) => prefScore(a) - prefScore(b) || a.length - b.length);
    const rpc = urls.slice(0, 5).map((url) => ({ url }));

    kept.push({
        chainId: chain.chainId,
        name: chain.name,
        shortName: chain.shortName,
        nativeCurrency: {
            name: chain.nativeCurrency?.name,
            symbol: chain.nativeCurrency?.symbol,
            decimals: chain.nativeCurrency?.decimals,
        },
        rpc,
    });
}

function prefScore(url) {
    const idx = RPC_PREFERENCE.findIndex((re) => re.test(url));
    return idx === -1 ? RPC_PREFERENCE.length : idx;
}

const outFile = path.join(ROOT, 'lib', 'rpcs.json');
const sizeBefore = readFileSync(inputFile, 'utf8').length;
writeFileSync(outFile, JSON.stringify(kept, null, 2) + '\n');
const sizeAfter = readFileSync(outFile, 'utf8').length;
console.log(`[trim-rpcs] ${source.length} 链 → ${kept.length} 链（主网 ${MAINNETS.length} + 测试网 ${TESTNETS.length}）`);
console.log(`[trim-rpcs] 体积 ${(sizeBefore / 1024 / 1024).toFixed(2)}MB → ${(sizeAfter / 1024).toFixed(1)}KB`);
if (missing.length) console.warn(`[trim-rpcs] 白名单里找不到的 chainId: ${missing.join(', ')}`);
