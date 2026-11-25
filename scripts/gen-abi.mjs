#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSources, syncGated } from '../../../scripts/lib/gen-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(__dirname, '../../..');
const HARDHAT_ROOT = path.resolve(
    process.env.HARDHAT_ROOT || path.join(REPO_ROOT, 'Stapleport_hardhat'),
);
const ALL_JSON = path.join(HARDHAT_ROOT, 'deployments', 'all.json');
const NEWINFO_DIR = path.join(HARDHAT_ROOT, 'deployments', 'newinfo');
const ARTIFACTS_DIR = path.join(HARDHAT_ROOT, 'artifacts');
const STANDARD_ABI_DIR = path.join(__dirname, 'standard-abis');

const ABI_FILE = path.join(PROXY_ROOT, 'lib', 'abi.json');
const VERSION_FILE = path.join(PROXY_ROOT, 'lib', 'version.js');

const CONTRACTS = {
    Imputations: {
        chains: ['31339', '31341'],
        artifact: 'contracts/Imputation/Imputations.sol/Imputations.json',
    },
};

const WHITELIST = ['token'];

const checkOnly = process.argv.includes('--check');

function listStandardAbis() {
    if (!existsSync(STANDARD_ABI_DIR)) return [];
    return readdirSync(STANDARD_ABI_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .map((f) => ({ key: path.basename(f, '.json'), path: path.join(STANDARD_ABI_DIR, f) }));
}

function sliceHardhatContracts() {
    const all = JSON.parse(readFileSync(ALL_JSON, 'utf8'));
    const out = {};
    for (const [name, cfg] of Object.entries(CONTRACTS)) {
        let abi = null;
        for (const chain of cfg.chains) {
            const entry = all[chain] && all[chain][name];
            if (entry && Array.isArray(entry.abi)) {
                abi = entry.abi;
                break;
            }
        }
        if (!abi) {
            const candidates = [
                path.join(ARTIFACTS_DIR, cfg.artifact),
                path.join(NEWINFO_DIR, `${name}.json`),
            ];
            for (const c of candidates) {
                if (existsSync(c)) {
                    const a = JSON.parse(readFileSync(c, 'utf8'));
                    if (Array.isArray(a.abi)) {
                        abi = a.abi;
                        break;
                    }
                }
            }
        }
        if (!abi) {
            console.error(
                `[gen] missing source: no ABI for contract ${name} in ${ALL_JSON} ` +
                    `(chains ${cfg.chains.join(',')}) nor ${path.join(ARTIFACTS_DIR, cfg.artifact)}`,
            );
            process.exit(1);
        }
        out[name] = abi;
    }
    return out;
}

function build() {
    const generated = {};
    for (const [k, v] of Object.entries(sliceHardhatContracts())) generated[k] = v;
    for (const s of standardAbis) generated[s.key] = JSON.parse(readFileSync(s.path, 'utf8'));

    let existing = null;
    if (existsSync(ABI_FILE)) {
        try {
            existing = JSON.parse(readFileSync(ABI_FILE, 'utf8'));
        } catch (e) {
            console.error(`[gen] existing ${ABI_FILE} unparseable (${e.message}); whitelist 无法保留`);
        }
    }
    for (const k of WHITELIST) {
        if (existing && existing[k] !== undefined) {
            generated[k] = existing[k];
        } else {
            console.error(`[gen] warn: whitelist key '${k}' not found in ${ABI_FILE}; nothing to preserve`);
        }
    }
    return { generated, content: JSON.stringify(generated, null, 2) + '\n' };
}

const standardAbis = listStandardAbis();
if (standardAbis.length === 0) {
    console.error(`[gen] missing source: no standard ABIs in ${STANDARD_ABI_DIR}`);
    process.exit(1);
}
const sources = [ALL_JSON, ...standardAbis.map((s) => s.path)];
assertSources(sources);

const { generated, content } = build();

if (checkOnly) {
    const stale = !existsSync(ABI_FILE) || readFileSync(ABI_FILE, 'utf8') !== content;
    if (stale) {
        console.error(`[gen-abi] abi.json 已过期：请运行 node scripts/gen-abi.mjs`);
        process.exit(1);
    }
    console.log(`[gen-abi] 已同步（${Object.keys(generated).length} keys）`);
    process.exit(0);
}

const { version, changed } = await syncGated({
    sourcePaths: sources,
    targetPath: ABI_FILE,
    render: () => content,
    versionModulePath: VERSION_FILE,
    repoRoot: PROXY_ROOT,
    header: false,
});
console.log(
    `[gen-abi] ${changed ? 'wrote' : 'unchanged'} ${path.relative(PROXY_ROOT, ABI_FILE)} ` +
        `(${Object.keys(generated).length} keys, version ${version})`,
);
