/**
 * 构建前把 vault/ 里的 Base64 解码回 Astro / public 能读的位置。
 * 由 predev / prebuild 自动调用；也可以单独跑：
 *
 *   npm run vault:decode
 *
 * 解码只写有变化的目标文件，不删除任何目标目录里的其它文件。
 * 如果目标目录里出现了 vault 没有对应条目的明文（例如刚写好还没编码的新日记），
 * 只打印文件名提醒，不打印内容，也不会动它。
 */
import { decodeAll, loadConfig, listTargetFiles, listVaultFiles, resolveRoot, toPosix } from './lib/vault.mjs';
import path from 'node:path';
import { targetFor } from './lib/vault.mjs';

const quiet = process.argv.includes('--quiet');
const config = await loadConfig();
const stats = await decodeAll({ config, quiet });

if (!quiet) {
  for (const mapping of config.mappings) {
    if (mapping.type !== 'dir') continue;
    const vaultNames = new Set(
      (await listVaultFiles(mapping)).map((file) => targetFor(mapping, file)),
    );
    const orphans = (await listTargetFiles(mapping)).filter((file) => !vaultNames.has(file));
    if (orphans.length > 0) {
      const shown = orphans.slice(0, 6).map((file) => path.basename(file));
      const rest = orphans.length - shown.length;
      console.warn(
        `[vault] ${mapping.target} 里有 ${orphans.length} 个文件还没有进 vault：` +
          shown.join(', ') +
          (rest > 0 ? ` … 另 ${rest} 个` : ''),
      );
      console.warn('        运行 npm run vault:encode 后再构建；它们目前也会被 Astro 读到。');
    }
  }
}

if (stats.errors.length) process.exitCode = 1;
