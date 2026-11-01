/**
 * 封存用到的密码学原语，和 demo/tools/seal.ts 保持同一套：
 * PBKDF2-SHA-256 600,000 次派生 KEK，AES-256-GCM，256-bit 随机 DEK。
 *
 * 这里只放 Node 端；浏览器端的同构实现放在 src/scripts/diary-unlock.ts，
 * 两边改算法时必须一起改，sealedHash 的材料顺序也要一致。
 */
import { webcrypto as crypto } from 'node:crypto';

export const ITERATIONS = 600_000;
export const KDF_HASH = 'SHA-256';
export const KDF_NAME = 'PBKDF2';
export const ALG = 'A256GCM';

const encoder = new TextEncoder();
const SHARE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const b64 = (value) =>
  Buffer.from(value instanceof Uint8Array ? value : new Uint8Array(value)).toString('base64');

export const bytesFromB64 = (value) => Buffer.from(value, 'base64');

export const randomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

export async function deriveKek(passphrase, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: KDF_HASH },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encrypt(key, data) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: b64(iv), ct: b64(ct) };
}

export async function decrypt(key, block) {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytesFromB64(block.iv) },
    key,
    bytesFromB64(block.ct),
  );
}

export async function importDek(bytes) {
  return crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * sealedHash 的材料顺序；浏览器端 verifySealed 必须完全一致。
 * 图片不进来：它们只在解锁后才取，且每张都有 GCM 认证，无需提前下载。
 */
export function sealedMaterial(sealed) {
  return [
    sealed.payload.iv,
    sealed.payload.ct,
    sealed.share?.salt ?? '',
    sealed.share?.iv ?? '',
    sealed.share?.ct ?? '',
  ].join('|');
}

export async function sealedHash(sealed) {
  return `sha256:${await sha256Hex(sealedMaterial(sealed))}`;
}

/** 分享码固定 20 位（100 bit）Crockford Base32；去掉容易混淆的 I / L / O / U */
export const SHARE_CODE_LENGTH = 20;

export function generateShareCode() {
  const bytes = randomBytes(SHARE_CODE_LENGTH);
  let out = '';
  for (const byte of bytes) out += SHARE_ALPHABET[byte % 32];
  return out;
}

export function normalizeShareCode(value) {
  return String(value)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

export function formatShareCode(code) {
  return normalizeShareCode(code).replace(/(.{4})(?=.)/g, '$1-');
}
