/**
 * 根目录 分享码.sealed.json：分享码的本机加密记录。
 *
 * 整份 JSON 用 keyring 的 KEK 再加密一次（KEK 由主密码派生），
 * 文件本身不含明文分享码，也不进仓库。每次写入前把上一版复制到
 * backups/share-codes/，写失败时旧文件保持原样。
 */
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './vault.mjs';
import { decrypt, encrypt } from './crypto.mjs';

export const SHARE_REGISTRY_PATH = path.join(ROOT, '分享码.sealed.json');
const BACKUP_DIR = path.join(ROOT, 'backups/share-codes');
const NOTE = '分享码记录：整份文件用主密码派生的密钥加密。不要提交到仓库。';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

async function backupCurrent() {
  if (!existsSync(SHARE_REGISTRY_PATH)) return;
  await mkdir(BACKUP_DIR, { recursive: true });
  const base = stamp();
  let dest = path.join(BACKUP_DIR, `${base}-分享码.sealed.json`);
  let index = 1;
  while (existsSync(dest)) {
    dest = path.join(BACKUP_DIR, `${base}-${index}-分享码.sealed.json`);
    index += 1;
  }
  await copyFile(SHARE_REGISTRY_PATH, dest);
}

async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, file);
}

export async function readShareRegistry(kek) {
  if (!existsSync(SHARE_REGISTRY_PATH)) {
    return { v: 1, entries: {} };
  }

  let raw;
  try {
    raw = JSON.parse(await readFile(SHARE_REGISTRY_PATH, 'utf8'));
  } catch {
    throw new Error('分享码文件不是合法 JSON');
  }
  if (raw?.v !== 1 || typeof raw.iv !== 'string' || typeof raw.ct !== 'string') {
    throw new Error('分享码文件结构不对');
  }

  let plain;
  try {
    plain = await decrypt(kek, raw);
  } catch {
    throw new Error('分享码文件解不开：主密码与 keyring 不匹配');
  }

  let data;
  try {
    data = JSON.parse(decoder.decode(plain));
  } catch {
    throw new Error('分享码文件内容损坏');
  }
  if (
    data?.v !== 1 ||
    !data.entries ||
    typeof data.entries !== 'object' ||
    Array.isArray(data.entries)
  ) {
    throw new Error('分享码文件内容结构不对');
  }
  return data;
}

export async function writeShareRegistry(kek, data) {
  const plain = encoder.encode(JSON.stringify({ v: 1, entries: data.entries }));
  const block = await encrypt(kek, plain);
  const output = {
    v: 1,
    note: NOTE,
    updated: new Date().toISOString(),
    iv: block.iv,
    ct: block.ct,
  };
  await backupCurrent();
  await writeAtomic(SHARE_REGISTRY_PATH, `${JSON.stringify(output, null, 2)}\n`);
}

export async function upsertShareCode(kek, data, entry) {
  if (!entry?.sealedId || !entry?.code || !entry?.slug) {
    throw new Error('分享码记录缺少 sealedId / slug / code');
  }
  data.entries[entry.sealedId] = { ...entry };
  await writeShareRegistry(kek, data);
  return entry;
}
