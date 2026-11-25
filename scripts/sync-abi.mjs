#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncGenerated } from '../../../scripts/lib/sync-generated-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ETHERS_NEXT_ROOT = path.resolve(__dirname, '..');
const HARDHAT_ROOT = path.resolve(
    process.env.HARDHAT_ROOT || path.join(ETHERS_NEXT_ROOT, '..', 'Stapleport_hardhat')
);
const STANDARD_ABI_DIR = path.join(__dirname, 'standard-abis');

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
    for (const c of changes) {
        if (!c.inSync) current[c.name] = c.freshAbi;
    }
    syncGenerated({
        destPath: abiFile,
        next: JSON.stringify(current, null, 2) + '\n',
        checkOnly,
        checkFail: '[abi-sync] ABI 已过期：请在 ethers_next 目录运行 npm run sync-abi 后再构建',
        onWrite: () => console.log(`[abi-sync] 已写入 ${path.relative(ETHERS_NEXT_ROOT, abiFile)}`),
    });
} else {
    console.log('[abi-sync] 全部一致，无需更新');
}
