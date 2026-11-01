/**
 * 查看 / 重签某一篇已封存日记的分享码。
 *
 *   npm run share -- <slug>                   查看
 *   npm run share -- <slug> --reissue --yes   重签（旧码立即失效）
 *
 * 查看和重签都需要主密码解公开 keyring；新分享码写入根目录
 * 分享码.sealed.json（主密码加密，只在本机）。重签只改 sealed.json 的
 * share 块与 sealedHash，payload 和图片密文不动。
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { ROOT, decodeText, resolveVault } from './lib/vault.mjs';
import { openKeyring, fail } from './lib/master.mjs';
import {
  readShareRegistry,
  upsertShareCode,
  writeShareRegistry,
} from './lib/share-registry.mjs';
import {
  ITERATIONS,
  b64,
  bytesFromB64,
  decrypt,
  deriveKek,
  encrypt,
  formatShareCode,
  generateShareCode,
  normalizeShareCode,
  randomBytes,
  sealedHash,
} from './lib/crypto.mjs';

const DIARY_DIR = path.join(ROOT, 'src/content/diary');
const SEALED_DIR = path.join(ROOT, 'public/diary/sealed');
const TAG = 'share';

function usage() {
  console.log(
    '用法：\n' +
      '  npm run share -- <slug>                   查看分享码\n' +
      '  npm run share -- <slug> --reissue --yes   重签分享码（旧码立即失效）',
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    usage();
    process.exit(args.length ? 0 : 1);
  }
  const allowed = new Set(['--reissue', '--yes']);
  const unknown = args.filter((arg) => arg.startsWith('-') && !allowed.has(arg));
  if (unknown.length) fail(TAG, `未知参数：${unknown.join(' ')}`);
  const target = args.find((arg) => !arg.startsWith('-'));
  if (!target) fail(TAG, '缺少日记 slug');
  return {
    target,
    reissue: args.includes('--reissue'),
    yes: args.includes('--yes'),
  };
}

function readFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error('找不到 YAML frontmatter');
  const data = yaml.load(match[1]) ?? {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('frontmatter 不是对象');
  }
  return data;
}

function dateLabel(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? '');
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

async function resolveStub(target) {
  let slug = target.endsWith('.md') ? path.basename(target, '.md') : path.basename(target);
  if (!slug || slug === '.' || slug === '..' || /[\\/]/.test(slug)) {
    fail(TAG, 'slug 不合法');
  }

  const vaultFile = resolveVault(`content/diary/${slug}.md.b64`);
  const srcFile = path.join(DIARY_DIR, `${slug}.md`);
  let text;
  if (existsSync(vaultFile)) {
    text = decodeText(await readFile(vaultFile, 'utf8'));
  } else if (existsSync(srcFile)) {
    text = await readFile(srcFile, 'utf8');
  } else {
    fail(TAG, `找不到日记：${slug}（vault 与 src/content/diary 都没有）`);
  }

  let data;
  try {
    data = readFrontmatter(text);
  } catch (error) {
    fail(TAG, `读不了 ${slug} 的 frontmatter：${error.message}`);
  }
  if (data.locked !== true || typeof data.sealedId !== 'string' || !data.sealedId) {
    fail(TAG, `这篇没有封存：${slug}`);
  }
  return { slug, data, sealedId: data.sealedId };
}

async function loadSealed(sealedId) {
  const file = path.join(SEALED_DIR, `${sealedId}.json`);
  if (!existsSync(file)) {
    fail(TAG, `找不到密文：public/diary/sealed/${sealedId}.json`);
  }
  let sealed;
  try {
    sealed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    fail(TAG, `密文不是合法 JSON：public/diary/sealed/${sealedId}.json`);
  }
  if (
    sealed?.v !== 1 ||
    sealed.entryId !== sealedId ||
    typeof sealed.share?.salt !== 'string' ||
    typeof sealed.share?.iv !== 'string' ||
    typeof sealed.share?.ct !== 'string'
  ) {
    fail(TAG, '密文结构不对');
  }
  return { file, sealed };
}

async function ensureSealedHash(sealed) {
  if (typeof sealed.sealedHash !== 'string') fail(TAG, '密文缺少 sealedHash');
  const expected = await sealedHash(sealed);
  if (sealed.sealedHash !== expected) {
    fail(TAG, '密文完整性校验没通过，先不要重签');
  }
}

async function codeMatches(code, sealed) {
  try {
    const iterations = Number(sealed.kdf?.iterations) || ITERATIONS;
    const kek = await deriveKek(
      normalizeShareCode(code),
      bytesFromB64(sealed.share.salt),
      iterations,
    );
    await decrypt(kek, sealed.share);
    return true;
  } catch {
    return false;
  }
}

async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

async function show(target, record, sealed) {
  console.log(`\n[${TAG}] ${target.slug}`);
  console.log(`  日期：${dateLabel(target.data.date)}`);
  console.log(`  密文：public/diary/sealed/${target.sealedId}.json`);

  if (!record) {
    console.log('  分享码记录：没有。');
    console.log('  这篇可能是在加入“分享码记录”之前封存的。');
    console.log('  要拿一个新分享码，请重签（重签分享码.bat 选 2）。');
    process.exitCode = 2;
    return;
  }

  const ok = await codeMatches(record.code, sealed);
  if (!ok) {
    console.log('  分享码记录：与当前密文对不上。');
    console.log('  可能上次重签没写完；请重签生成新码。');
    process.exitCode = 3;
    return;
  }

  console.log(`  记录更新：${record.updatedAt ?? record.createdAt ?? '未知'}`);
  if (Number(record.reissued) > 0) {
    console.log(`  已重签：${record.reissued} 次`);
  }
  console.log('  记录文件：分享码.sealed.json（主密码加密，不入库）');
  console.log('  ----------------------------------------');
  console.log(`  分享码：${record.code}`);
}

async function reissue(target, record, sealed, sealedFile, keyring, registry) {
  const oldCode = record?.code ?? null;
  const beforeRegistry = JSON.parse(JSON.stringify(registry));

  const newCode = generateShareCode();
  const salt = randomBytes(16);
  const iterations = Number(sealed.kdf?.iterations) || ITERATIONS;
  const shareKek = await deriveKek(normalizeShareCode(newCode), salt, iterations);
  const dekBytes = bytesFromB64(keyring.data.entries[target.sealedId]);
  const block = await encrypt(shareKek, dekBytes);

  sealed.share = { salt: b64(salt), iv: block.iv, ct: block.ct };
  sealed.sealedHash = await sealedHash(sealed);

  const now = new Date().toISOString();
  const entry = {
    slug: target.slug,
    date: record?.date ?? dateLabel(target.data.date),
    sealedId: target.sealedId,
    code: formatShareCode(newCode),
    createdAt: record?.createdAt ?? now,
    updatedAt: now,
    reissued: Number(record?.reissued ?? 0) + 1,
  };

  try {
    await upsertShareCode(keyring.kek, registry, entry);
  } catch (error) {
    fail(TAG, `分享码记录写入失败，密文未改：${error.message}`);
  }

  try {
    await writeJsonAtomic(sealedFile, sealed);
  } catch (error) {
    try {
      await writeShareRegistry(keyring.kek, beforeRegistry);
    } catch {
      /* 回滚失败时，保留原始错误信息 */
    }
    fail(TAG, `密文写入失败，已尽量回滚分享码记录：${error.message}`);
  }

  console.log(`\n[${TAG}] 已重签 ${target.slug}`);
  console.log(`  旧分享码：${oldCode ?? '没有记录（旧版本封存）'}`);
  console.log('  已保存到 分享码.sealed.json（主密码加密，不入库）。');
  console.log(
    `  提交 public/diary/sealed/${target.sealedId}.json 后，线上才会换成新码。`,
  );
  console.log('  ----------------------------------------');
  console.log(`  新分享码：${entry.code}`);
}

async function main() {
  const { target, reissue: wantReissue, yes } = parseArgs(process.argv);
  if (!globalThis.crypto?.subtle) fail(TAG, '当前 Node 没有 WebCrypto');

  const stub = await resolveStub(target);
  const { file: sealedFile, sealed } = await loadSealed(stub.sealedId);
  await ensureSealedHash(sealed);

  if (wantReissue && !yes) {
    console.log(`\n[${TAG}] 重签会让旧分享码立即失效。确认后重新运行，并加上 --yes。`);
    process.exit(1);
  }

  const keyring = await openKeyring({ create: false, tag: TAG });
  const dek = keyring.data.entries[stub.sealedId];
  if (typeof dek !== 'string' || !dek) {
    fail(TAG, 'keyring 里没有这一篇的 DEK；无法重签。');
  }

  let registry;
  try {
    registry = await readShareRegistry(keyring.kek);
  } catch (error) {
    fail(TAG, `分享码记录读不出来：${error.message}`);
  }
  const record = registry.entries[stub.sealedId] ?? null;

  if (!wantReissue) {
    await show(stub, record, sealed);
    return;
  }

  await reissue(stub, record, sealed, sealedFile, keyring, registry);
}

await main();
