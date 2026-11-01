/**
 * 主密码与公开 keyring 的共用逻辑。
 * seal-diary.mjs（封存）和 share-code.mjs（查看 / 重签分享码）必须走同一套
 * 密码校验与 KDF，否则两边会得出不同的 KEK。
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './vault.mjs';
import {
  ITERATIONS,
  bytesFromB64,
  decrypt,
  deriveKek,
  randomBytes,
} from './crypto.mjs';

export const KEYRING_PATH = path.join(ROOT, 'public/diary/keyring.json');
const decoder = new TextDecoder('utf-8', { fatal: true });

export function fail(tag, message) {
  console.error(`\n[${tag}] ${message}`);
  process.exit(1);
}

/** 读密码时关掉回显；兼容 bracketed paste（粘贴不会把 ESC 序列吃进密码） */
export async function promptHidden(label) {
  if (!process.stdin.isTTY) {
    throw new Error('当前不是交互终端，请用 MOXO_MASTER_PASSWORD 提供主密码');
  }
  process.stdout.write(label);
  const stdin = process.stdin;
  const wasRaw = Boolean(stdin.isRaw);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let value = '';
    let escaped = false;
    let csi = false;

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onData = (chunk) => {
      for (const char of chunk) {
        if (escaped) {
          escaped = false;
          if (char === '[') csi = true;
          continue;
        }
        if (csi) {
          if (char >= '@' && char <= '~') csi = false;
          continue;
        }
        if (char === '\u001b') {
          escaped = true;
          continue;
        }
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          reject(new Error('已取消'));
          return;
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stdin.on('data', onData);
  });
}

export async function readMasterPassword({ confirm, tag }) {
  const fromEnv = process.env.MOXO_MASTER_PASSWORD;
  if (fromEnv) {
    console.log(`[${tag}] 主密码来自 MOXO_MASTER_PASSWORD（不会写入任何文件）。`);
    return fromEnv;
  }

  const first = await promptHidden(confirm ? '设置主密码：' : '主密码：');
  if (!first) fail(tag, '主密码不能为空');
  if (!confirm) return first;

  const second = await promptHidden('再输一次：');
  if (first !== second) fail(tag, '两次输入不一致，请重新运行');
  return first;
}

export async function openKeyring({ create = true, tag = 'seal' } = {}) {
  if (!existsSync(KEYRING_PATH)) {
    if (!create) {
      fail(tag, 'public/diary/keyring.json 不存在；没有它无法重签分享码。');
    }
    console.log(`[${tag}] 还没有 keyring，这次会创建公开钥匙环。`);
    const password = await readMasterPassword({ confirm: true, tag });
    const salt = randomBytes(16);
    const kek = await deriveKek(password, salt, ITERATIONS);
    return { raw: null, salt, kek, data: { v: 1, entries: {} } };
  }

  let raw;
  try {
    raw = JSON.parse(await readFile(KEYRING_PATH, 'utf8'));
  } catch {
    fail(tag, 'public/diary/keyring.json 不是合法 JSON');
  }
  if (raw?.v !== 1 || !raw.salt || !raw.iv || !raw.ct) {
    fail(tag, 'public/diary/keyring.json 结构不对');
  }
  const iterations = Number(raw.kdf?.iterations) || ITERATIONS;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const password = await readMasterPassword({ confirm: false, tag });
    try {
      const salt = bytesFromB64(raw.salt);
      const kek = await deriveKek(password, salt, iterations);
      const plain = await decrypt(kek, raw);
      const data = JSON.parse(decoder.decode(plain));
      if (data?.v !== 1 || !data.entries || typeof data.entries !== 'object') {
        fail(tag, 'keyring 解开后结构不对');
      }
      return { raw, salt, kek, data };
    } catch {
      console.error(`[${tag}] 主密码不对（${attempt}/3）。`);
    }
  }
  fail(tag, '主密码连续三次不对，已退出');
}
