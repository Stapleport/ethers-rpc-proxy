#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const MAINNETS = [
    1,
    10,
    25,
    56,
    100,
    137,
    204,
    250,
    324,
    8453,
    42161,
    43114,
    5000,
    59144,
    534352,
];
const TESTNETS = [
    97,
    80002,
    84532,
    421614,
    11155111,
    11155420,
];
const WHITELIST = new Set([...MAINNETS, ...TESTNETS]);

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
