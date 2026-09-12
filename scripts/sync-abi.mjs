#!/usr/bin/env node
/**
 * 同步合约 ABI 到 lib/abi.json，两类来源：
 *   1. hardhat 编译产物（SweepPay_hardhat/artifacts，跟链上部署版本走）
 *   2. scripts/standard-abis/*.json（人工维护的标准合约接口：ERC721/ERC1155 等）
 *
 * 用法（都在 ethers_next 目录执行）：
 *   npm run sync-abi   # 同步并写入 lib/abi.json，打印函数增删差异
 *   npm run check-abi  # 只校验是否同步（构建前检查），不一致时退出码 1
 *
 * hardhat 源目录可用环境变量 HARDHAT_ROOT 覆盖，默认取仓库隔壁的 SweepPay_hardhat。
 * 找不到 hardhat artifacts 时（如 Vercel 独立部署）自动跳过 artifacts 部分，不阻塞构建。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ETHERS_NEXT_ROOT = path.resolve(__dirname, '..');
const HARDHAT_ROOT = path.resolve(
    process.env.HARDHAT_ROOT || path.join(ETHERS_NEXT_ROOT, '..', 'SweepPay_hardhat')
);
const STANDARD_ABI_DIR = path.join(__dirname, 'standard-abis');

// 合约名 → artifacts 内的相对路径（以后要同步别的合约在这里加一行）
const CONTRACTS = {
    Imputations: 'contracts/Imputation/Imputations.sol/Imputations.json',
};

const checkOnly = process.argv.includes('--check');
const abiFile = path.join(ETHERS_NEXT_ROOT, 'lib', 'abi.json');
const hasHardhatArtifacts = existsSync(path.join(HARDHAT_ROOT, 'artifacts'));

if (!hasHardhatArtifacts) {
    console.log(`[abi-sync] 未找到 hardhat artifacts（${HARDHAT_ROOT}），跳过 artifacts 同步`);
}

const current = JSON.parse(readFileSync(abiFile, 'utf8'));
const changes = [];
const fnNames = (abi) =>
    new Set((abi || []).filter((e) => e.type === 'function').map((e) => e.name));

function trackChange(name, oldAbi, freshAbi) {
    const oldNames = fnNames(oldAbi);
    const newNames = fnNames(freshAbi);
    changes.push({
        name,
        added: [...newNames].filter((n) => !oldNames.has(n)),
        removed: [...oldNames].filter((n) => !newNames.has(n)),
        inSync: JSON.stringify(oldAbi) === JSON.stringify(freshAbi),
        fnCount: newNames.size,
        freshAbi,
    });
}

if (hasHardhatArtifacts) {
    for (const [name, relPath] of Object.entries(CONTRACTS)) {
        const artifactPath = path.join(HARDHAT_ROOT, 'artifacts', relPath);
        if (!existsSync(artifactPath)) {
            console.error(`[abi-sync] 找不到 artifact: ${artifactPath}`);
            process.exit(1);
        }
        const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
        trackChange(name, current[name], artifact.abi);
    }
}

// 标准合约接口：文件名即 lib/abi.json 里的键名，源文件永远是最新版
if (existsSync(STANDARD_ABI_DIR)) {
    for (const file of readdirSync(STANDARD_ABI_DIR).filter((f) => f.endsWith('.json')).sort()) {
        const name = path.basename(file, '.json');
        const stdAbi = JSON.parse(readFileSync(path.join(STANDARD_ABI_DIR, file), 'utf8'));
        trackChange(name, current[name], stdAbi);
    }
}

let changed = false;
for (const c of changes) {
    if (c.inSync) {
        console.log(`[abi-sync] ${c.name}: 已同步（${c.fnCount} 个函数）`);
    } else {
        console.log(`[abi-sync] ${c.name}: 不一致（新 ABI 共 ${c.fnCount} 个函数）`);
        if (c.added.length) console.log(`  + ${c.added.join(', ')}`);
        if (c.removed.length) console.log(`  - ${c.removed.join(', ')}`);
        changed = true;
    }
}

if (changed) {
    if (checkOnly) {
        console.error('[abi-sync] ABI 已过期：请在 ethers_next 目录运行 npm run sync-abi 后再构建');
        process.exit(1);
    }
    for (const c of changes) {
        if (!c.inSync) current[c.name] = c.freshAbi;
    }
    writeFileSync(abiFile, JSON.stringify(current, null, 2) + '\n');
    console.log(`[abi-sync] 已写入 ${path.relative(ETHERS_NEXT_ROOT, abiFile)}`);
} else {
    console.log('[abi-sync] 全部一致，无需更新');
}
