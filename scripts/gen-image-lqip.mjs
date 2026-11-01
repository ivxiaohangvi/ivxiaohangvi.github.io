// 为 public 下的日记/摄影配图生成渐进式加载资源：
//   1) LQIP：24px 宽的 WebP，base64 内联进 HTML，首帧即有马赛克轮廓
//   2) 列表小图：≤480px WebP，日记列表缩略图专用，省掉中画质/原图
//   3) 中画质：≤900px WebP，懒加载先传输这一档
//   4) 原图：中画质 load 完且进视口后由 progressive-images.ts 升级
// 产物：public/<dir>/med/<name>.webp、public/<dir>/thumb/<name>.webp
//       + src/lib/image-lqip.json（构建期清单）
// 增量：清单里记录源文件内容的 SHA-256，未变的跳过；缺哪一档就补哪一档。
// 用内容哈希而不是 mtime：CI 每次都是新 clone，mtime 全变会让 472 张图每次重算；
// 内容没变时，换机器、换时间、重新 checkout 都能命中。
// 用法：node scripts/gen-image-lqip.mjs [--force]
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(import.meta.dirname, '..');
const FORCE = process.argv.includes('--force');

/** 扫描哪些 public 目录（键前缀 = URL 前缀） */
const SOURCES = [
  { dir: 'public/diary/images', url: '/diary/images' },
  { dir: 'public/photos', url: '/photos' },
  { dir: 'public/moments', url: '/moments' },
];

const MANIFEST_PATH = path.join(ROOT, 'src/lib/image-lqip.json');
const LQIP_W = 24;
const MED_W = 900;
const MED_Q = 62;
const THUMB_W = 480;
const THUMB_Q = 64;

/** 只处理位图，跳过 svg 与已生成的 med/thumb 目录 */
const isBitmap = (name) => /\.(webp|jpe?g|png|avif)$/i.test(name);
const GENERATED = new Set(['med', 'thumb']);

async function collect() {
  const files = [];
  for (const { dir, url } of SOURCES) {
    const abs = path.join(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const name of await readdir(abs, { recursive: true })) {
      const rel = String(name);
      if (rel.split(/[\\/]/).some((part) => GENERATED.has(part))) continue;
      if (!isBitmap(rel)) continue;
      files.push({ abs: path.join(abs, rel), urlPath: `${url}/${rel.split(path.win32.sep).join('/')}` });
    }
  }
  return files;
}

async function loadManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function processOne({ abs, urlPath }, prev) {
  const buffer = await readFile(abs);
  const sig = createHash('sha256').update(buffer).digest('hex').slice(0, 32);
  const medPath = path.join(path.dirname(abs), 'med', path.basename(abs));
  const thumbPath = path.join(path.dirname(abs), 'thumb', path.basename(abs));
  // 旧清单没有 thumb 字段，或产物被删过，都要重跑这一张
  const complete =
    prev?.sig === sig && prev.entry?.thumb && existsSync(medPath) && existsSync(thumbPath);
  if (!FORCE && complete) return prev;

  const img = sharp(buffer, { failOn: 'none' });
  const md = await img.metadata();
  // metadata() 给的是未旋转画布；orientation 5-8 表示浏览器显示时会转 90°，宽高要对调
  const swapped = md.orientation >= 5 && md.orientation <= 8;
  const width = swapped ? md.height : md.width;
  const height = swapped ? md.width : md.height;
  if (!width || !height) return null;

  await mkdir(path.dirname(medPath), { recursive: true });
  await mkdir(path.dirname(thumbPath), { recursive: true });

  const [lqipBuf] = await Promise.all([
    img.clone().resize(LQIP_W, undefined, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 40 }).toBuffer(),
    img
      .clone()
      .resize(MED_W, undefined, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: MED_Q, effort: 6 })
      .toFile(medPath),
    img
      .clone()
      .resize(THUMB_W, undefined, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: THUMB_Q, effort: 6 })
      .toFile(thumbPath),
  ]);

  const dirname = path.posix.dirname(urlPath);
  const base = path.basename(urlPath);
  return {
    sig,
    entry: {
      w: width,
      h: height,
      med: `${dirname}/med/${base}`,
      thumb: `${dirname}/thumb/${base}`,
      lqip: `data:image/webp;base64,${lqipBuf.toString('base64')}`,
    },
  };
}

const files = await collect();
const manifest = await loadManifest();
const next = {};
let done = 0;
let skipped = 0;

for (const file of files) {
  const result = await processOne(file, manifest[file.urlPath]);
  if (result) {
    next[file.urlPath] = result;
    if (result.sig === manifest[file.urlPath]?.sig && !FORCE) skipped++;
  }
  if (++done % 100 === 0) console.log(`  ${done}/${files.length} ...`);
}

await writeFile(MANIFEST_PATH, JSON.stringify(next));
const entries = Object.values(next);
const totalBytes = async (tier) =>
  (
    await Promise.all(
      files
        .map((f) => path.join(path.dirname(f.abs), tier, path.basename(f.abs)))
        .filter((p) => existsSync(p))
        .map((p) => stat(p).then((s) => s.size)),
    )
  ).reduce((a, b) => a + b, 0);
const [medBytes, thumbBytes] = await Promise.all([totalBytes('med'), totalBytes('thumb')]);

console.log(
  `[lqip] ${entries.length} images (${skipped} cached), ` +
    `lqip avg ${(entries.reduce((a, e) => a + e.entry.lqip.length, 0) / Math.max(entries.length, 1) / 1024).toFixed(2)}KB, ` +
    `med total ${(medBytes / 1024 / 1024).toFixed(1)}MB, ` +
    `thumb total ${(thumbBytes / 1024 / 1024).toFixed(1)}MB -> src/lib/image-lqip.json`,
);
