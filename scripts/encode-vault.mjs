/**
 * 把映射表里的目标文件编码进 vault/。
 *
 *   npm run vault:encode              # 只编码，保留明文
 *   npm run vault:encode -- --remove  # 编码 + 往返校验通过后移除明文
 *   node scripts/encode-vault.mjs --only src/content/diary
 *
 * 目录映射会递归处理子目录；vault 里的相对路径与目标目录一致。
 * 编码器不打印任何文件内容。
 */
import { encodeAll, loadConfig, ROOT, toPosix } from './lib/vault.mjs';

const args = process.argv.slice(2);
const remove = args.includes('--remove');
const quiet = args.includes('--quiet');
const onlyIndex = args.indexOf('--only');
const only = onlyIndex >= 0 ? args[onlyIndex + 1] : null;

if (onlyIndex >= 0 && !only) {
  console.error('--only 后面要跟 mapping 里的 vault 或 target 路径。');
  process.exit(1);
}

const config = await loadConfig();
const known = config.mappings.flatMap((mapping) => [mapping.vault, mapping.target]);
if (only && !known.includes(toPosix(only))) {
  console.error(`--only 找不到映射: ${only}`);
  console.error(`可用: ${known.join(' / ')}`);
  process.exit(1);
}

const stats = await encodeAll({ config, remove, only, quiet });
if (stats.errors.length) process.exitCode = 1;
if (!quiet && !remove && stats.files > 0) {
  console.log(`[vault] 明文仍在原处；确认构建无误后可加 --remove 清掉（位置: ${toPosix(ROOT)}）。`);
}
