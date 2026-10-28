#!/usr/bin/env node
/**
 * gen-abi.mjs —— NC8 线：单源生成制切片生成 lib/abi.json（plan §1.2#3 / docs/plans/generation-sync-plan.md）。
 *
 * 单源（任一缺失 → assertSources 非零退出并打印缺失绝对路径，禁静默跳过/沿用旧副本）：
 *   1) Stapleport_hardhat/deployments/all.json          —— 链上合约 ABI（按 CONTRACTS[].chains 优先序取桶）
 *   2) Stapleport_hardhat/artifacts/** + deployments/newinfo/**  —— all.json 缺该合约时的 artifact 回落
 *   3) scripts/standard-abis/*.json                     —— 人工维护的标准合约接口（文件名即输出键名）
 *
 * 生成物：
 *   - lib/abi.json    整文件幂等重写（字节对拍，仅差异时写；2 空格缩进 + 尾换行）
 *   - lib/version.js  版本门（export const VERSION = { target, version }，格式同 gen-lib §1.1 契约）
 *
 * 版本门：走 gen-lib `syncGated({ ..., header:false })` 正典调用——abi.json 被 rpcHandler.js 以
 *   `import abiConfig from './abi.json' with { type: 'json' }` 消费，JSON 不接受注释头，故目标传
 *   header:false 免注入 `// @generated` 头（version.js 为 JS，恒带头）。版本戳格式（content-<hex16>）、
 *   target 身份校验（错挂防护）、内容字节对拍搬回均由 syncGated 承担。
 *
 * 白名单段（超集条目保留，见 plan §2 T3「超集条目保留=生成器白名单段」）：
 *   下列输出键在单源里无对应（人工增补），生成时从现 lib/abi.json 原样保留，缺则告警不落：
 *     - token  最小 ERC20 读接口（abi 名 "token"）。无 standard-abis/token.json、hardhat all.json 亦无；
 *              消费方 lib/rpcHandler.js + lib/addresses.json（weth/usdt/usdc 均 abi:"token"）按此名引用，
 *              test/read-only.test.mjs 断言 addressBook.usdc.abi === 'token'。
 *   （若后续把某键补进单源，从 WHITELIST 删除即可。）
 *
 * 用法：
 *   node scripts/gen-abi.mjs           生成/更新 lib/abi.json + lib/version.js
 *   node scripts/gen-abi.mjs --check   只校验（abi.json 过期则退出码 1，不写）
 *   HARDHAT_ROOT=/path node ...        覆盖 hardhat 源根（缺源报错实测用）
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSources, syncGated } from '../../../scripts/lib/gen-lib.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY_ROOT = path.resolve(__dirname, '..'); // 本仓（ethers-rpc-proxy）根
const REPO_ROOT = path.resolve(__dirname, '../../..'); // Stapleport/（hardhat 源根定位用）
const HARDHAT_ROOT = path.resolve(
    process.env.HARDHAT_ROOT || path.join(REPO_ROOT, 'Stapleport_hardhat'),
);
const ALL_JSON = path.join(HARDHAT_ROOT, 'deployments', 'all.json');
const NEWINFO_DIR = path.join(HARDHAT_ROOT, 'deployments', 'newinfo');
const ARTIFACTS_DIR = path.join(HARDHAT_ROOT, 'artifacts');
const STANDARD_ABI_DIR = path.join(__dirname, 'standard-abis');

const ABI_FILE = path.join(PROXY_ROOT, 'lib', 'abi.json');
const VERSION_FILE = path.join(PROXY_ROOT, 'lib', 'version.js');

// 链上合约 → all.json 取桶链优先序 + artifacts 回落相对路径（以后加合约在此加一行）。
const CONTRACTS = {
    Imputations: {
        chains: ['31339', '31341'],
        artifact: 'contracts/Imputation/Imputations.sol/Imputations.json',
    },
};

// 白名单：无单源的输出键（人工增补），从现 lib/abi.json 原样保留。见文件头注。
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
            // artifacts 回落：hardhat artifacts/**，其次 deployments/newinfo/<name>.json
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

// 组装生成物：链上合约 → 标准接口 → 白名单保留（确定性顺序，幂等）。
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
    header: false, // abi.json 为 JSON，免注释头
});
console.log(
    `[gen-abi] ${changed ? 'wrote' : 'unchanged'} ${path.relative(PROXY_ROOT, ABI_FILE)} ` +
        `(${Object.keys(generated).length} keys, version ${version})`,
);
