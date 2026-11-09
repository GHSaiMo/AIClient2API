// 将完整基准池脱敏后导出到可入库路径（完整版 configs/baselines/ 保持被 git 忽略）
// 用法: node scripts/export-redacted-baseline.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'configs/baselines/provider_pools.baseline.json');
const DST = path.join(ROOT, 'configs/baseline-redacted/provider_pools.baseline.redacted.json');

const SECRET_KEYS = /(COOKIE|TOKEN|CLEARANCE|SECRET|PASSWORD|API_?KEY|CF_BM|STATSIG)/i;
const pools = JSON.parse(fs.readFileSync(SRC, 'utf8'));
for (const nodes of Object.values(pools)) {
  for (const n of nodes) {
    for (const [k, v] of Object.entries(n)) {
      if (typeof v === 'string' && v && SECRET_KEYS.test(k)) n[k] = '<REDACTED>';
    }
    if (n.lastErrorMessage) n.lastErrorMessage = '<REDACTED>';
  }
}
// 邮箱统一匿名化（同一邮箱映射到同一占位符，保持节点可区分）
const map = new Map();
const text = JSON.stringify(pools, null, 2).replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, (m) => {
  if (!map.has(m)) map.set(m, `user${map.size + 1}@redacted.example`);
  return map.get(m);
});
fs.writeFileSync(DST, text + '\n');
console.log(`Wrote ${path.relative(ROOT, DST)} (${map.size} emails masked)`);
