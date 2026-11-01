/**
 * Base64 vault：把不想让陌生人直接在 GitHub 仓库里检索到的源文件
 * 以整文件 Base64 的形式存在 vault/，构建前再解码回 Astro / public 能读的位置。
 *
 * - 不是加密：只是防止明文被仓库代码搜索命中；内容可逆，见 README 的说明。
 * - 映射表在 vault/vault.config.json；以后新页面要复用，只加一条 mapping，
 *   再跑 `npm run vault:encode`，不需要再写一套脚本。
 * - 编码与解码都不打印文件内容，只报路径、数量与失败原因。
 */
import { createHash } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const CONFIG_PATH = path.join(ROOT, 'vault/vault.config.json');
export const B64_EXT = '.b64';
const LINE_WIDTH = 120;

const utf8 = new TextDecoder('utf-8', { fatal: true });

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export function toPosix(value) {
  return value.split(path.sep).join('/');
}

export async function loadConfig(file = CONFIG_PATH) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  if (!raw || !Array.isArray(raw.mappings)) {
    throw new Error('vault.config.json 缺少 mappings 数组');
  }
  for (const mapping of raw.mappings) {
    if (mapping.type !== 'dir' && mapping.type !== 'file') {
      throw new Error(`vault.config.json 里有未知 type: ${mapping.type}`);
    }
    if (!mapping.vault || !mapping.target) {
      throw new Error('vault.config.json 的每条 mapping 都需要 vault 与 target');
    }
  }
  return raw;
}

export function resolveRoot(rel) {
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
    throw new Error(`路径越界: ${rel}`);
  }
  return abs;
}

/** mapping.vault 是 vault/ 内的相对路径，避免和项目根的 content/ 撞名 */
export function resolveVault(rel) {
  return resolveRoot(path.join('vault', rel));
}

/** 标准 Base64，每 120 列换行，末尾一个换行：GitHub 上不会变成一条巨长的行 */
export function encodeBuffer(buffer) {
  const raw = buffer.toString('base64');
  const lines = raw.match(new RegExp(`.{1,${LINE_WIDTH}}`, 'g')) ?? [];
  return `${lines.join('\n')}\n`;
}

/** 容忍空白、CRLF、缺失 padding 与 BOM；拒绝非 UTF-8 内容 */
export function decodeBuffer(text) {
  let normalized = text.replace(/^\uFEFF/, '').replace(/\s+/g, '').replace(/=+$/, '');
  if (!normalized) throw new Error('Base64 内容为空');
  if (!/^[A-Za-z0-9+/]+$/.test(normalized)) throw new Error('含有非 Base64 字符');
  normalized = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const buffer = Buffer.from(normalized, 'base64');
  if (buffer.toString('base64') !== normalized) throw new Error('Base64 校验失败');
  utf8.decode(buffer);
  return buffer;
}

export function encodeText(text) {
  return encodeBuffer(Buffer.from(text, 'utf8'));
}

export function decodeText(text) {
  return decodeBuffer(text).toString('utf8');
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function writeAtomic(file, data) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/** 目录映射下每个 .b64 → 去掉后缀的目标文件；单文件映射固定一对一 */
export function targetFor(mapping, vaultFile) {
  if (mapping.type === 'file') return resolveRoot(mapping.target);
  const name = path.basename(vaultFile);
  if (!name.endsWith(B64_EXT)) return null;
  return resolveRoot(path.join(mapping.target, name.slice(0, -B64_EXT.length)));
}

export async function listVaultFiles(mapping) {
  const dir = resolveVault(mapping.vault);
  if (!(await exists(dir))) return [];
  if (mapping.type === 'file') {
    return (await exists(dir)) && dir.endsWith(B64_EXT) ? [dir] : [];
  }
  const out = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(B64_EXT)) continue;
    const parent = entry.parentPath ?? entry.path;
    out.push(path.join(parent, entry.name));
  }
  return out.sort();
}

export async function listTargetFiles(mapping) {
  const target = resolveRoot(mapping.target);
  if (mapping.type === 'file') return (await exists(target)) ? [target] : [];
  if (!(await exists(target))) return [];
  const out = [];
  for (const entry of await readdir(target, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    if (name.startsWith('.')) continue;
    if (name.endsWith(B64_EXT)) continue;
    const parent = entry.parentPath ?? entry.path;
    out.push(path.join(parent, name));
  }
  return out.sort();
}

/** 解码全部映射；默认只写有变化的目标文件 */
export async function decodeAll({ config, quiet = false } = {}) {
  config ??= await loadConfig();
  const stats = { files: 0, written: 0, unchanged: 0, skipped: 0, errors: [] };

  for (const mapping of config.mappings) {
    for (const vaultFile of await listVaultFiles(mapping)) {
      const target = targetFor(mapping, vaultFile);
      if (!target) {
        stats.skipped += 1;
        continue;
      }
      try {
        const text = await readFile(vaultFile, 'utf8');
        const buffer = decodeBuffer(text);
        const current = (await exists(target)) ? await readFile(target) : null;
        if (current && current.equals(buffer)) {
          stats.unchanged += 1;
          continue;
        }
        await writeAtomic(target, buffer);
        stats.files += 1;
        stats.written += 1;
      } catch (error) {
        stats.errors.push(`${toPosix(path.relative(ROOT, vaultFile))}: ${error.message}`);
      }
    }
  }

  if (!quiet) {
    const parts = [`[vault] 解码 ${stats.written} 个文件`];
    if (stats.unchanged) parts.push(`${stats.unchanged} 个未变`);
    if (stats.skipped) parts.push(`${stats.skipped} 个跳过`);
    console.log(parts.join('，'));
    if (stats.errors.length) {
      for (const error of stats.errors) console.error(`  ! ${error}`);
      process.exitCode = 1;
    }
  }

  return stats;
}

/** 编码一个目标文件：读原文 → 编码 → 解码回来比对 SHA-256，确认无损 */
export async function encodeFile(targetFile, vaultFile) {
  const original = await readFile(targetFile);
  const text = original.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(original)) {
    throw new Error('不是合法的 UTF-8 文本');
  }
  const encoded = encodeText(text);
  const roundTrip = decodeBuffer(encoded);
  if (sha256(roundTrip) !== sha256(original)) {
    throw new Error('往返校验失败，未写入 vault');
  }

  const previous = (await exists(vaultFile)) ? await readFile(vaultFile, 'utf8') : null;
  if (previous !== encoded) await writeAtomic(vaultFile, encoded);
  return { changed: previous !== encoded, bytes: original.length };
}

/** 编码全部映射；--remove 时在全部成功后删除明文（先校验，后删除） */
export async function encodeAll({
  config,
  remove = false,
  only = null,
  quiet = false,
} = {}) {
  config ??= await loadConfig();
  const stats = { files: 0, changed: 0, bytes: 0, removed: 0, errors: [], plaintexts: [] };

  for (const mapping of config.mappings) {
    if (only && mapping.vault !== only && mapping.target !== only) continue;
    const targets = await listTargetFiles(mapping);
    for (const target of targets) {
      const vaultFile =
        mapping.type === 'file'
          ? resolveVault(mapping.vault)
          : resolveVault(path.join(mapping.vault, `${toPosix(path.relative(resolveRoot(mapping.target), target))}${B64_EXT}`));
      try {
        const result = await encodeFile(target, vaultFile);
        stats.files += 1;
        stats.bytes += result.bytes;
        if (result.changed) stats.changed += 1;
        stats.plaintexts.push(target);
      } catch (error) {
        stats.errors.push(`${toPosix(path.relative(ROOT, target))}: ${error.message}`);
      }
    }
  }

  if (remove && stats.errors.length === 0) {
    for (const target of stats.plaintexts) {
      await unlink(target);
      stats.removed += 1;
    }
  }

  if (!quiet) {
    console.log(
      `[vault] 编码 ${stats.files} 个文件（${(stats.bytes / 1024 / 1024).toFixed(2)} MB），` +
        `${stats.changed} 个有更新${remove ? `，已移除 ${stats.removed} 个明文` : ''}`,
    );
    if (stats.errors.length) {
      for (const error of stats.errors) console.error(`  ! ${error}`);
      console.error('[vault] 有文件失败，明文一个都没有删除。');
      process.exitCode = 1;
    }
  }

  return stats;
}
