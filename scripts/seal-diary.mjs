/**
 * 把一篇日记封存成公开可提交的密文：
 *   Markdown 正文 → 与 Astro 相同的 Markdown 处理器渲染成 HTML
 *   标题 / 正文 / 打字机词库 / 图片元数据 → AES-256-GCM payload
 *   图片 → 逐张加密成 public/diary/sealed/<sealedId>/img-N.bin
 *   公开侧只留：日期、时间、心情、locked、sealedId、是否有加密附图
 *
 * 主密码模型 M1：public/diary/keyring.json 是公开的钥匙环，
 * 主密码派生 KEK 解开它，里面是每篇的 DEK；分享码只包这一篇的 DEK。
 * 分享码同时用主密码加密写入根目录 分享码.sealed.json（本机记录，不入库）。
 *
 * 用法：
 *   npm run seal -- <slug 或 src/content/diary/xxx.md>
 *   MOXO_MASTER_PASSWORD='…' npm run seal -- <slug>   # 非交互 / 自动化测试
 *
 * 原文件与原始图片在删除前会复制到 backups/seal-originals/<sealedId>/，
 * 该目录被 .gitignore 忽略，只留在本机用于还原。
 */
import { access, copyFile, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import { buildTypingLexicon } from '../src/lib/typing-data.ts';
import {
  ROOT,
  decodeText,
  encodeFile,
  resolveVault,
  toPosix,
} from './lib/vault.mjs';
import {
  ALG,
  ITERATIONS,
  KDF_HASH,
  KDF_NAME,
  b64,
  bytesFromB64,
  decrypt,
  deriveKek,
  encrypt,
  formatShareCode,
  generateShareCode,
  importDek,
  normalizeShareCode,
  randomBytes,
  sealedHash,
} from './lib/crypto.mjs';
import { KEYRING_PATH, openKeyring } from './lib/master.mjs';
import {
  SHARE_REGISTRY_PATH,
  readShareRegistry,
  upsertShareCode,
} from './lib/share-registry.mjs';

const DIARY_DIR = path.join(ROOT, 'src/content/diary');
const SEALED_DIR = path.join(ROOT, 'public/diary/sealed');
const BACKUP_DIR = path.join(ROOT, 'backups/seal-originals');
const MANIFEST_PATH = path.join(ROOT, 'src/lib/image-lqip.json');
const PUBLIC_DIR = path.join(ROOT, 'public');

const encoder = new TextEncoder();
const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
};

const IMG_TAG = /<img\b[^>]*>/gi;
const ATTR_CACHE = new Map();

function fail(message) {
  console.error(`\n[seal] ${message}`);
  process.exit(1);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function decodeEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function readAttr(tag, name) {
  const key = `${name}\u0000${tag}`;
  const cached = ATTR_CACHE.get(key);
  if (cached !== undefined) return cached;
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = tag.match(re);
  const value = match ? (match[1] ?? match[2] ?? match[3]) : null;
  ATTR_CACHE.set(key, value);
  return value;
}

function stripAttr(tag, name) {
  return tag.replace(new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+)`, 'gi'), '');
}

function isLocalUrl(url) {
  return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//');
}

function publicFileFor(url) {
  if (!isLocalUrl(url)) return null;
  let clean = url.split(/[?#]/)[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    /* 保留原样，后面按普通路径处理 */
  }
  const abs = path.resolve(PUBLIC_DIR, `.${clean}`);
  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) return null;
  return { abs, rel: toPosix(path.relative(ROOT, abs)), publicRel: toPosix(path.relative(PUBLIC_DIR, abs)) };
}

function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

function splitFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error('找不到 YAML frontmatter');
  const data = yaml.load(match[1]) ?? {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('frontmatter 不是对象');
  }
  return { data, body: match[2] ?? '' };
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log(
      '用法：npm run seal -- <日记 slug 或 src/content/diary/xxx.md>\n' +
        '非交互环境可用 MOXO_MASTER_PASSWORD 提供主密码（不会写入任何文件）。',
    );
    process.exit(args.length ? 0 : 1);
  }
  const target = args.find((arg) => !arg.startsWith('-'));
  if (!target) fail('缺少日记 slug 或文件路径');
  const unknown = args.filter((arg) => arg.startsWith('-'));
  if (unknown.length) fail(`未知参数：${unknown.join(' ')}`);
  return target;
}

function resolveEntryFile(target) {
  if (target.endsWith('.md')) {
    const abs = path.resolve(ROOT, target);
    if (abs !== DIARY_DIR && !abs.startsWith(DIARY_DIR + path.sep)) {
      fail('只能封存 src/content/diary/ 里的日记');
    }
    return abs;
  }
  return path.join(DIARY_DIR, `${target}.md`);
}

async function writeKeyring(keyring, dekBytes, sealedId) {
  keyring.data.entries[sealedId] = b64(dekBytes);
  const plain = encoder.encode(JSON.stringify({ v: 1, entries: keyring.data.entries }));
  const block = await encrypt(keyring.kek, plain);
  const output = {
    v: 1,
    kdf: { name: KDF_NAME, hash: KDF_HASH, iterations: Number(keyring.raw?.kdf?.iterations) || ITERATIONS },
    salt: b64(keyring.salt),
    iv: block.iv,
    ct: block.ct,
    updated: new Date().toISOString(),
  };
  await mkdir(path.dirname(KEYRING_PATH), { recursive: true });
  await writeFile(KEYRING_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
}

async function collectTextFiles(dir, skip) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const parent = entry.parentPath ?? entry.path;
    const file = path.join(parent, entry.name);
    if (file === skip) continue;
    if (!/\.(md|markdown|astro|ts|js|mjs|html)$/i.test(entry.name)) continue;
    out.push(file);
  }
  return out;
}

/** 同一张图若还被公开条目引用，封存后会把那边弄坏：先查出来并拒绝 */
async function assertNotReferencedElsewhere(urls, currentFile) {
  if (urls.length === 0) return;
  const files = [
    ...(await collectTextFiles(DIARY_DIR, currentFile)),
    ...(await collectTextFiles(path.join(ROOT, 'src/content/moments'), null)),
    path.join(ROOT, 'src/pages/infinity.astro'),
  ].filter((file) => existsSync(file));

  const hits = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    for (const url of urls) {
      if (text.includes(url)) {
        hits.push(`${toPosix(path.relative(ROOT, file))} → ${url}`);
      }
    }
  }
  if (hits.length) {
    fail(
      '这些图片还被别的公开条目引用，先解开共用再封存：\n  ' + hits.join('\n  '),
    );
  }
}

async function loadEntry(target) {
  const file = resolveEntryFile(target);
  const vaultFile = resolveVault(`content/diary/${path.basename(file)}.b64`);
  let text;
  let vaultText = null;

  if (existsSync(vaultFile)) {
    vaultText = await readFile(vaultFile, 'utf8');
    text = decodeText(vaultText);
    const current = existsSync(file) ? await readFile(file, 'utf8') : null;
    if (current !== text) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text, 'utf8');
    }
  } else if (existsSync(file)) {
    text = await readFile(file, 'utf8');
  } else {
    fail(`找不到日记：${toPosix(path.relative(ROOT, file))}（vault 与明文都没有）`);
  }

  return { file, vaultFile, text, vaultText };
}

async function renderHtml(body, file) {
  const processor = await createMarkdownProcessor({});
  const result = await processor.render(body, { fileURL: pathToFileURL(file) });
  return result.code;
}

async function backupOriginals({ sealedId, entry, imageFiles }) {
  const backupRoot = path.join(BACKUP_DIR, sealedId);
  await mkdir(backupRoot, { recursive: true });

  // 必须在改写成 stub 之前备份：这里写的是封存前的原文与原始 vault
  await writeFile(path.join(backupRoot, 'entry.md'), entry.text, 'utf8');
  if (entry.vaultText !== null) {
    await writeFile(path.join(backupRoot, 'entry.md.b64'), entry.vaultText, 'utf8');
  }

  for (const image of imageFiles) {
    const dest = path.join(backupRoot, image.rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(image.abs, dest);
  }

  await writeFile(
    path.join(backupRoot, 'seal.json'),
    `${JSON.stringify(
      {
        sealedId,
        entry: toPosix(path.relative(ROOT, entry.file)),
        images: imageFiles.map((image) => image.rel),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  return backupRoot;
}

/** 密文、keyring 与 stub 都落盘成功之后才删原图 */
async function removeOriginalImages(imageFiles) {
  for (const image of imageFiles) {
    await unlink(image.abs);
    for (const tier of ['med', 'thumb']) {
      const variant = path.join(path.dirname(image.abs), tier, path.basename(image.abs));
      if (existsSync(variant)) await unlink(variant);
    }
  }
}

async function dropFromManifest(urls) {
  if (urls.length === 0 || !existsSync(MANIFEST_PATH)) return;
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  let changed = false;
  for (const url of urls) {
    if (manifest[url]) {
      delete manifest[url];
      changed = true;
    }
  }
  if (changed) await writeFile(MANIFEST_PATH, JSON.stringify(manifest), 'utf8');
}

function dateLabel(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value ?? '');
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function buildStub(data, sealedId, hasEncryptedImages) {
  const stub = {
    date: data.date,
    timeKnown: data.timeKnown === true,
    mood: data.mood,
    locked: true,
    sealedId,
    hasEncryptedImages,
    sample: data.sample === true,
  };
  for (const key of ['timeKnown', 'mood', 'hasEncryptedImages', 'sample']) {
    if (!stub[key]) delete stub[key];
  }
  const front = yaml.dump(stub, { lineWidth: 120 }).trimEnd();
  return `---\n${front}\n---\n`;
}

async function main() {
  const target = parseArgs(process.argv);
  if (!globalThis.crypto?.subtle) fail('当前 Node 没有 WebCrypto');

  const entry = await loadEntry(target);
  const slug = path.basename(entry.file, '.md');

  const { data, body } = splitFrontmatter(entry.text);
  if (data.locked === true) fail('frontmatter 已经标记 locked: true');
  if (Array.isArray(data.attachments) && data.attachments.length > 0) {
    fail('这篇日记带附件；附件还不支持加密，请先移除或另存，再封存');
  }
  if (existsSync(SHARE_REGISTRY_PATH) && !existsSync(KEYRING_PATH)) {
    fail('根目录有分享码记录，但 public/diary/keyring.json 不见了。先把 keyring 找回来，不要新建。');
  }

  console.log(`[seal] 准备封存 ${slug}…`);
  const keyring = await openKeyring();
  let shareRegistry;
  try {
    shareRegistry = await readShareRegistry(keyring.kek);
  } catch (error) {
    fail(`分享码记录读不出来：${error.message}`);
  }

  const sealedId = `s-${Buffer.from(randomBytes(9)).toString('base64url')}`;
  const dekBytes = randomBytes(32);
  const dek = await importDek(dekBytes);

  /* —— 找出所有要加密的图片：frontmatter 附图 + 正文渲染后的 <img> —— */
  const gallerySources = Array.isArray(data.images) ? data.images.filter(Boolean) : [];
  const html = await renderHtml(body, entry.file);
  const bodySources = [];
  for (const tag of html.match(IMG_TAG) ?? []) {
    const src = readAttr(tag, 'src');
    if (src) bodySources.push(decodeEntities(src));
  }

  const allSources = [...new Set([...gallerySources, ...bodySources])];  const imageRecords = [];
  const skipped = [];
  const bySource = new Map();

  for (const src of allSources) {
    if (!isLocalUrl(src)) {
      skipped.push(src);
      continue;
    }
    const file = publicFileFor(src);
    if (!file || !existsSync(file.abs)) {
      fail(`找不到图片：${src}（应在 public${src}）`);
    }
    const bytes = await readFile(file.abs);
    const block = await encrypt(dek, bytes);
    const n = imageRecords.length;
    imageRecords.push({
      n,
      src,
      abs: file.abs,
      rel: file.rel,
      file: `img-${n}.bin`,
      mime: mimeOf(file.abs),
      iv: block.iv,
      ct: block.ct,
    });
    bySource.set(src, n);
  }

  await assertNotReferencedElsewhere(
    imageRecords.map((image) => image.src),
    entry.file,
  );

  /* —— 正文里的本地图片改成占位属性，解锁后再填 Blob URL —— */
  const sealedHtml = html.replace(IMG_TAG, (tag) => {
    const rawSrc = readAttr(tag, 'src');
    if (!rawSrc) return tag;
    const src = decodeEntities(rawSrc);
    const n = bySource.get(src);
    if (n === undefined) return tag;
    let next = stripAttr(tag, 'src');
    next = stripAttr(next, 'srcset');
    next = stripAttr(next, 'data-full');
    return next.replace(/^<img\b/i, `<img data-sealed-image="${n}"`);
  });

  const imagesBySource = new Map(imageRecords.map((image) => [image.src, image]));
  const gallery = gallerySources.map((src) => {
    const local = imagesBySource.get(src);
    if (local) {
      return {
        n: local.n,
        mime: local.mime,
        back: typeof data.imageBacks?.[src] === 'string' ? data.imageBacks[src].trim() : '',
      };
    }
    return { n: null, src, back: typeof data.imageBacks?.[src] === 'string' ? data.imageBacks[src].trim() : '' };
  });

  const lexicon = buildTypingLexicon(body);
  const payload = {
    v: 1,
    id: sealedId,
    title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null,
    html: sealedHtml,
    lexicon,
    gallery,
    images: imageRecords.map(({ n, file, mime }) => ({ n, file, mime })),
  };

  const payloadBlock = await encrypt(dek, encoder.encode(JSON.stringify(payload)));

  /* —— 分享码：20 位（100 bit）Crockford Base32；同时加密存到本机记录 —— */
  const shareCode = generateShareCode();
  const shareSalt = randomBytes(16);
  const shareKek = await deriveKek(normalizeShareCode(shareCode), shareSalt, ITERATIONS);
  const shareBlock = await encrypt(shareKek, dekBytes);
  const savedAt = new Date().toISOString();
  const shareRecord = {
    slug,
    date: dateLabel(data.date),
    sealedId,
    code: formatShareCode(shareCode),
    createdAt: savedAt,
    updatedAt: savedAt,
    reissued: 0,
  };

  const sealed = {
    v: 1,
    alg: ALG,
    kdf: { name: KDF_NAME, hash: KDF_HASH, iterations: ITERATIONS },
    entryId: sealedId,
    share: { salt: b64(shareSalt), iv: shareBlock.iv, ct: shareBlock.ct },
    payload: payloadBlock,
    images: imageRecords.map(({ n, file }) => ({ n, file })),
  };
  sealed.sealedHash = await sealedHash(sealed);

  /* —— 落盘：备份原文 → 密文图片 → sealed.json → keyring → 分享码记录 → stub → vault → 清理原图 —— */
  const backupRoot = await backupOriginals({ sealedId, entry, imageFiles: imageRecords });

  const sealedDir = path.join(SEALED_DIR, sealedId);
  await mkdir(sealedDir, { recursive: true });
  for (const image of imageRecords) {
    await writeFile(
      path.join(sealedDir, image.file),
      Buffer.concat([bytesFromB64(image.iv), bytesFromB64(image.ct)]),
    );
  }
  await writeFile(
    path.join(SEALED_DIR, `${sealedId}.json`),
    `${JSON.stringify(sealed, null, 2)}\n`,
    'utf8',
  );

  await writeKeyring(keyring, dekBytes, sealedId);

  try {
    await upsertShareCode(keyring.kek, shareRegistry, shareRecord);
  } catch (error) {
    fail(`分享码没能保存：${error.message}。原文还没有被覆盖，修好后重跑即可。`);
  }

  const stub = buildStub(data, sealedId, imageRecords.length > 0);
  await writeFile(entry.file, stub, 'utf8');
  const encoded = await encodeFile(entry.file, entry.vaultFile);

  await removeOriginalImages(imageRecords);
  await dropFromManifest(imageRecords.map((image) => image.src));

  const imageBytes = imageRecords.reduce(
    (sum, image) => sum + bytesFromB64(image.iv).length + bytesFromB64(image.ct).length,
    0,
  );

  console.log(`\n[seal] 已封存 ${slug}`);
  console.log(`  密文：public/diary/sealed/${sealedId}.json`);
  if (imageRecords.length) {
    console.log(`  图片：${imageRecords.length} 张，${(imageBytes / 1024 / 1024).toFixed(2)} MB`);
  }
  if (skipped.length) {
    console.log(`  外链图片保持公开：${skipped.length} 张`);
  }
  console.log(`  keyring：已更新（${Object.keys(keyring.data.entries).length} 篇可被主密码打开）`);
  console.log(`  备份：${toPosix(path.relative(ROOT, backupRoot))}/（本机还原用，不入库）`);
  console.log(`  公开 stub：${toPosix(path.relative(ROOT, entry.file))} → vault ${encoded.changed ? '已更新' : '无变化'}`);
  console.log('  分享码已用主密码加密保存到 分享码.sealed.json（本机记录，不入库）。');
  console.log('  之后查看或重签：运行 重签分享码.bat。');
  console.log('  主密码没有写入任何文件；忘了分享码可以用主密码重签一个。');
  console.log('  ----------------------------------------');
  console.log(`  分享码（仅解锁这一篇）：${formatShareCode(shareCode)}`);
}

await main();
