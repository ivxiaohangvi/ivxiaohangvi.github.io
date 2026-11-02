/**
 * Daily You（https://github.com/Demizo/Daily_You）Markdown 导出导入器
 *
 * 导出格式（从 Daily You 源码 export_utils.dart 核实）：
 *   log_YYYY-MM-DD.md            ← 每条日记一个文件，同日多篇加 _2/_3 后缀
 *   ![](Images/xxx.jpg)          ← 图片引用行，文件在导出包 Images/ 目录
 *   [xxx](audio/xxx.m4a)         ← 非图片附件为链接形式（audio/ video/ files/ 等目录）
 *   😊 2026年10月25日星期日       ← 心情 emoji + 本地化日期（一行）
 *   <正文 Markdown>
 *
 * 用法：
 *   npm run import:diary -- <导出解压目录> [--db <daily_you.db>] [--dry]
 *   node scripts/import-daily-you.mjs <导出解压目录> [--db <daily_you.db>] [--dry]
 *
 * 行为：
 *   1. 每条日记 → src/content/diary/<日期>.md（同日多篇自动 -2/-3 后缀）
 *   2. 自动寻找同级的 Daily You 备份，用正文内容哈希匹配 time_create，写入北京时间
 *   3. 图片转成 1600px 以内的 WebP，剥掉 EXIF / GPS；附件原样复制到 public/diary/
 *   4. 心情 emoji 原文捕获到 frontmatter mood
 *   5. 日记里的单行换行会转成 Markdown 硬换行，页面上不再挤成一团
 *   6. 重复导入安全：同名日记覆盖，已转换且比原图新的图片直接跳过
 *   7. 成功导入后移除旧的 sample 示例日记
 *   8. 导入完成后自动把 src/content/diary 同步编码进 vault（只编码，不删明文）
 */
import { readdir, readFile, writeFile, mkdir, copyFile, access, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { encodeAll } from './lib/vault.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
const dry = args.includes('--dry');
let exportDir;
let dbArg;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--dry') continue;
  if (arg === '--db') {
    dbArg = args[++i];
    continue;
  }
  if (arg.startsWith('--db=')) {
    dbArg = arg.slice(5);
    continue;
  }
  if (!exportDir) exportDir = arg;
}

if (!exportDir) {
  console.error('用法: npm run import:diary -- <Daily You 导出解压目录> [--db <daily_you.db>] [--dry]');
  process.exit(1);
}
exportDir = path.resolve(exportDir);

const outDiaryDir = path.join(root, 'src/content/diary');
const outAssetDir = path.join(root, 'public/diary');
const IMAGE_MAX = 1600;
const IMAGE_QUALITY = 78;

/** 匹配 Daily You 的心情 emoji（含 ☺️、ZWJ 组合 emoji 与肤色修饰符） */
const MOOD_RE = /^(?<mood>\u263a\ufe0f?|(?:\p{Emoji_Presentation}|\p{Emoji_Modifier_Base}|\p{Emoji_Modifier}|\u200d|\ufe0f)+)\s*/u;
/** 本地化日期行：2026年10月25日星期日 / 2026-10-25 / 2026/10/25 */
const DATE_LINE_RE = /^(?:\d{4}年\d{1,2}月\d{1,2}日.*|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}.*)$/u;
/** 开头的附件引用行：![alt](Images/x.jpg) / [name](audio/x.m4a) */
const REF_LINE_RE = /^(?<bang>!?)\[[^\]]*\]\((?<folder>images|audio|video|files)\/(?<name>[^/)]+)\)\s*$/i;
/** 正文中的本地附件引用：![alt](Images/x.jpg) / [name](audio/x.m4a) */
const INLINE_ASSET_RE = /(?<label>!?\[[^\]]*\])\((?<folder>images|audio|video|files)\/(?<name>[^)]+)\)/gi;

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.dng', '.heic', '.tif', '.tiff']);
const AUDIO_EXT = new Set(['.m4a', '.mp3', '.wav', '.ogg', '.aac', '.flac', '.opus']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);

const SENSITIVE_RE = /小[鱼魚]|[鱼魚]|[🐟🐠🐡]/gu;
const REDACT_HTML =
  '<span class="redact" data-pagefind-ignore role="img" aria-label="已隐去">██</span>';

function isImage(file) {
  return IMAGE_EXT.has(path.extname(file).toLowerCase());
}

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  return 'file';
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** 防止导出包里的相对路径跳出导出目录 */
function resolveInside(base, rel) {
  const baseAbs = path.resolve(base);
  const target = path.resolve(baseAbs, rel);
  if (target !== baseAbs && !target.startsWith(baseAbs + path.sep)) {
    throw new Error(`附件路径越界: ${rel}`);
  }
  return target;
}

function splitMood(line) {
  const m = line.match(MOOD_RE);
  if (!m) return { mood: undefined, rest: line };
  return { mood: m.groups.mood, rest: line.slice(m[0].length) };
}

/** 只保护链接目标，正文与 alt 里的敏感词照常涂黑 */
function redactMarkdown(input) {
  const urls = [];
  const protectedText = input.replace(/(\]\()([^)\s]+)(\))/g, (_match, open, url, close) => {
    const index = urls.push(url) - 1;
    return `${open}\u0000${index}\u0000${close}`;
  });
  return protectedText
    .replace(SENSITIVE_RE, REDACT_HTML)
    .replace(/\u0000(\d+)\u0000/g, (_match, index) => urls[Number(index)]);
}

function redactPlain(input) {
  return input.replace(SENSITIVE_RE, '██');
}

function publicRelForImage(rel) {
  const [folder, ...rest] = rel.split('/');
  const file = rest.join('/');
  const base = path.posix.basename(file, path.extname(file));
  return `images/${base}.webp`;
}

function publicRelForFile(rel) {
  const [folder, ...rest] = rel.split('/');
  return `${folder.toLowerCase()}/${rest.join('/')}`;
}

function publicUrl(rel) {
  return `/diary/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

function countRedactions(text) {
  return text.match(SENSITIVE_RE)?.length ?? 0;
}

/** 用正文本身匹配备份里的记录，不依赖 _2/_3 后缀的顺序 */
function normalizeForMatch(text) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/[#>*_`~-]/g, '')
    .replace(/\s+/g, '');
}

function hashText(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function bigrams(text) {
  const map = new Map();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    map.set(gram, (map.get(gram) ?? 0) + 1);
  }
  return map;
}

function diceSimilarity(a, b) {
  if (!a.length && !b.length) return 1;
  if (!a.length || !b.length) return 0;
  const left = bigrams(a);
  const right = bigrams(b);
  let intersection = 0;
  let total = 0;
  for (const [gram, count] of left) {
    intersection += Math.min(count, right.get(gram) ?? 0);
    total += count;
  }
  for (const count of right.values()) total += count;
  return (2 * intersection) / total;
}

/** 数据库里存的是本地时间，补上北京时区偏移即可 */
function beijingTimestamp(value) {
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+08:00`;
}

async function findDatabase(start) {
  if (dbArg) {
    const candidate = path.resolve(dbArg);
    if (path.extname(candidate).toLowerCase() === '.db') return candidate;
    const inside = path.join(candidate, 'daily_you.db');
    if (await exists(inside)) return inside;
    return candidate;
  }

  let dir = path.resolve(start);
  if (path.basename(dir).toLowerCase() === 'logs') dir = path.dirname(dir);

  const roots = [dir, path.dirname(dir)];
  for (const searchRoot of roots) {
    const direct = path.join(searchRoot, 'daily_you.db');
    if (await exists(direct)) return direct;

    let entries;
    try {
      entries = await readdir(searchRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(searchRoot, entry.name, 'daily_you.db');
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

async function loadDatabaseRows(file) {
  if (!file) {
    console.warn('没有找到 Daily You 备份（daily_you.db），这次只会写入日期。可用 --db 指定备份位置。');
    return [];
  }

  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare('SELECT id, text, mood, time_create FROM entries')
      .all()
      .map((row) => {
        const normalized = normalizeForMatch(String(row.text ?? ''));
        return {
          id: row.id,
          time: String(row.time_create),
          date: String(row.time_create).slice(0, 10),
          normalized,
          hash: hashText(normalized),
        };
      });
    db.close();
    return rows;
  } catch (error) {
    console.warn(`读取 Daily You 备份失败，将只写入日期：${error.message}`);
    return [];
  }
}

/**
 * 先按内容哈希精确匹配；同一天内哈希相同或原文格式略有差异时，
 * 再用字符二元组相似度挑最接近的一条。只处理时间和哈希，不输出正文。
 */
function assignTimes(records, rows) {
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.date)) byDate.set(row.date, []);
    byDate.get(row.date).push(row);
  }

  const used = new Map();
  let exact = 0;
  let fuzzy = 0;

  const recordsByDate = new Map();
  for (const record of records) {
    if (!recordsByDate.has(record.date)) recordsByDate.set(record.date, []);
    recordsByDate.get(record.date).push(record);
  }

  for (const [date, dayRecords] of recordsByDate) {
    const dayRows = byDate.get(date) ?? [];
    const usedHere = used.get(date) ?? new Set();
    used.set(date, usedHere);

    for (const record of dayRecords) {
      const match = dayRows.find((row) => !usedHere.has(row.id) && row.hash === record.hash);
      if (!match) continue;
      record.timestamp = beijingTimestamp(match.time);
      usedHere.add(match.id);
      exact++;
    }

    for (const record of dayRecords.filter((item) => !item.timestamp)) {
      const candidates = dayRows
        .filter((row) => !usedHere.has(row.id))
        .map((row) => ({ row, score: diceSimilarity(record.normalized, row.normalized) }))
        .sort((a, b) => b.score - a.score || a.row.time.localeCompare(b.row.time));
      if (candidates.length === 0) continue;
      record.timestamp = beijingTimestamp(candidates[0].row.time);
      usedHere.add(candidates[0].row.id);
      fuzzy++;
    }
  }

  return { exact, fuzzy };
}

/** 单行换行在 CommonMark 里会变成空格；日记按原样分行，所以补成硬换行 */
function withHardBreaks(text) {
  const lines = text.split('\n');
  let fenced = false;
  const output = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^(```|~~~)/.test(trimmed)) {
      fenced = !fenced;
      output.push(line);
      continue;
    }
    if (fenced || !trimmed) {
      output.push(line);
      continue;
    }

    const next = lines[i + 1] ?? '';
    if (!next.trim()) {
      output.push(line);
      continue;
    }
    if (/^(?:#{1,6}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(trimmed) || /^<[^>]+>$/.test(trimmed)) {
      output.push(line);
      continue;
    }

    output.push(`${line.replace(/[ \t]+$/, '')}  `);
  }

  return output.join('\n');
}

const files = (await readdir(exportDir))
  .filter((f) => /^log_\d{4}-\d{2}-\d{2}(_\d+)?\.md$/.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

// 传入的是解压根目录而非 logs/ 子目录时，自动下探一层
if (files.length === 0) {
  const subdirs = (await readdir(exportDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => path.join(exportDir, d.name));
  for (const sub of subdirs) {
    const subFiles = (await readdir(sub))
      .filter((f) => /^log_\d{4}-\d{2}-\d{2}(_\d+)?\.md$/.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (subFiles.length > 0) {
      console.log(`在 ${path.basename(sub)}/ 下找到日记文件。`);
      exportDir = sub;
      files.push(...subFiles);
      break;
    }
  }
}

if (files.length === 0) {
  console.error(`在 ${exportDir} 中没有找到 log_YYYY-MM-DD.md 文件。请确认这是 Daily You 的 Markdown 导出包。`);
  process.exit(1);
}

if (!dry) {
  await mkdir(outDiaryDir, { recursive: true });
  await mkdir(outAssetDir, { recursive: true });
}

const assetCache = new Map();
let copied = 0;
let converted = 0;
let skippedAssets = 0;
let imageCount = 0;
let attachmentCount = 0;
let redactionCount = 0;

/** 同一张图片在一次导入里只处理一次，返回公开 URL */
function prepareImage(rel) {
  if (assetCache.has(rel)) return assetCache.get(rel);

  const task = (async () => {
    const src = resolveInside(exportDir, rel);
    if (!(await exists(src))) {
      console.warn(`  ! 缺少图片 ${rel}（跳过）`);
      return null;
    }

    const outRel = publicRelForImage(rel);
    const dest = resolveInside(outAssetDir, outRel);
    const url = publicUrl(outRel);

    if (!dry) {
      if (await exists(dest)) {
        const [srcStat, destStat] = await Promise.all([stat(src), stat(dest)]);
        if (destStat.mtimeMs >= srcStat.mtimeMs) {
          skippedAssets++;
          return url;
        }
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await sharp(src, { failOn: 'none', limitInputPixels: false })
        .rotate()
        .resize({ width: IMAGE_MAX, height: IMAGE_MAX, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: IMAGE_QUALITY, effort: 4 })
        .toFile(dest);
      converted++;
      copied++;
    }
    return url;
  })();

  assetCache.set(rel, task);
  return task;
}

function prepareFile(rel) {
  if (assetCache.has(rel)) return assetCache.get(rel);

  const task = (async () => {
    const src = resolveInside(exportDir, rel);
    if (!(await exists(src))) {
      console.warn(`  ! 缺少附件 ${rel}（跳过）`);
      return null;
    }

    const outRel = publicRelForFile(rel);
    const dest = resolveInside(outAssetDir, outRel);
    const url = publicUrl(outRel);

    if (!dry) {
      if (await exists(dest)) {
        const [srcStat, destStat] = await Promise.all([stat(src), stat(dest)]);
        if (destStat.mtimeMs >= srcStat.mtimeMs) {
          skippedAssets++;
          return url;
        }
      }
      await mkdir(path.dirname(dest), { recursive: true });
      await copyFile(src, dest);
      copied++;
    }
    return url;
  })();

  assetCache.set(rel, task);
  return task;
}

/** 第一遍：只解析结构和正文哈希，用来匹配备份里的时间 */
const records = [];
for (const file of files) {
  const m = file.match(/^log_(?<date>\d{4}-\d{2}-\d{2})(?:_(?<n>\d+))?\.md$/);
  const date = m.groups.date;
  const dayIndex = m.groups.n ? `-${m.groups.n}` : '';

  const raw = await readFile(path.join(exportDir, file), 'utf8');
  const lines = raw.split(/\r?\n/);

  const leadingRefs = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const ref = line.match(REF_LINE_RE);
    if (!ref) break;
    const rel = `${ref.groups.folder}/${ref.groups.name}`;
    leadingRefs.push({ rel, image: ref.groups.bang === '!' || isImage(ref.groups.name) });
  }

  let mood;
  const first = lines[i] ?? '';
  const { mood: maybeMood, rest } = splitMood(first);
  if (DATE_LINE_RE.test(rest.trim())) {
    mood = maybeMood;
    i++;
  } else if (DATE_LINE_RE.test(first.trim())) {
    i++;
  } else if (maybeMood && !rest.trim()) {
    mood = maybeMood;
    i++;
  }

  const bodySource = lines.slice(i).join('\n');
  const normalized = normalizeForMatch(bodySource);

  records.push({
    file,
    date,
    dayIndex,
    mood,
    bodySource,
    normalized,
    hash: hashText(normalized),
    leadingRefs,
  });
}

const dbFile = await findDatabase(exportDir);
const dbRows = await loadDatabaseRows(dbFile);
const timeStats = assignTimes(records, dbRows);
const withTime = records.filter((record) => record.timestamp).length;

const importedNames = new Set();
let imported = 0;

for (const record of records) {
  const { file, date, dayIndex, mood, bodySource, leadingRefs } = record;

  // 改写正文里的本地附件引用
  const inlineRefs = [...bodySource.matchAll(INLINE_ASSET_RE)];
  let bodyText = bodySource;
  for (const ref of inlineRefs) {
    const rel = `${ref.groups.folder}/${ref.groups.name}`;
    const isImageRef = ref.groups.label.startsWith('!') || isImage(ref.groups.name);
    const url = isImageRef ? await prepareImage(rel) : await prepareFile(rel);
    if (!url) continue;
    const original = ref[0];
    const next = original.replace(/\([^)]*\)$/, `(${url})`);
    bodyText = bodyText.replace(original, next);
  }

  // 处理开头图片 / 附件
  const images = [];
  const attachments = [];
  for (const ref of leadingRefs) {
    if (ref.image) {
      const url = await prepareImage(ref.rel);
      if (url) images.push(url);
      imageCount++;
    } else {
      const url = await prepareFile(ref.rel);
      if (url) {
        attachments.push({
          name: redactPlain(ref.rel.split('/').at(-1)),
          url,
          kind: kindOf(ref.rel),
        });
      }
      attachmentCount++;
    }
  }

  // 写入前涂黑；原文只存在于这次进程里
  redactionCount += countRedactions(bodyText);
  const body = withHardBreaks(redactMarkdown(bodyText).trim());

  // 写入 Astro 内容集合
  const dateValue = record.timestamp ?? date;
  const frontmatterLines = ['---', `date: ${JSON.stringify(dateValue)}`];
  if (record.timestamp) frontmatterLines.push('timeKnown: true');
  if (mood) frontmatterLines.push(`mood: ${JSON.stringify(mood)}`);
  if (images.length > 0) {
    frontmatterLines.push('images:');
    for (const url of images) frontmatterLines.push(`  - ${JSON.stringify(url)}`);
  }
  if (attachments.length > 0) {
    frontmatterLines.push('attachments:');
    for (const att of attachments) {
      frontmatterLines.push(`  - name: ${JSON.stringify(att.name)}`);
      frontmatterLines.push(`    url: ${JSON.stringify(att.url)}`);
      frontmatterLines.push(`    kind: ${att.kind}`);
    }
  }
  frontmatterLines.push('---', '');

  const outName = `${date}${dayIndex}.md`;
  importedNames.add(outName);
  if (!dry) {
    await writeFile(path.join(outDiaryDir, outName), `${frontmatterLines.join('\n')}\n${body}\n`, 'utf8');
  }
  imported++;
  if (imported % 25 === 0) console.log(`  已处理 ${imported}/${files.length} 篇…`);
}

let removedSamples = 0;
if (!dry) {
  for (const name of await readdir(outDiaryDir)) {
    if (!name.endsWith('.md') || importedNames.has(name)) continue;
    const file = path.join(outDiaryDir, name);
    const text = await readFile(file, 'utf8');
    if (/^---[\s\S]*?\nsample:\s*true\b/m.test(text)) {
      await unlink(file);
      removedSamples++;
    }
  }
}

console.log(
  `\n完成：导入 ${imported} 篇日记、${imageCount} 张图片引用、${attachmentCount} 个附件。`,
);
console.log(
  `时间：${withTime}/${imported} 篇从备份恢复为北京时间（精确 ${timeStats.exact}，相近 ${timeStats.fuzzy}）。`,
);
console.log(
  `图片处理：新生成 ${converted} 张 WebP，跳过 ${skippedAssets} 个已有文件；涂黑 ${redactionCount} 处。`,
);
if (removedSamples > 0) console.log(`已移除 ${removedSamples} 篇旧的示例日记。`);

if (!dry) {
  const vaultStats = await encodeAll({ only: 'src/content/diary', quiet: true });
  console.log(
    `vault：已同步 ${vaultStats.files} 个日记文件（${vaultStats.changed} 个有更新）。`,
  );
  if (vaultStats.errors.length) {
    for (const error of vaultStats.errors) console.error(`  ! ${error}`);
    console.error('vault 编码有失败，提交前先修好，否则新日记不会进仓库。');
    process.exitCode = 1;
  }
}

console.log(dry ? '（dry run，未写入任何文件）' : `公开资源位于 public/diary/，原始导出没有被复制进仓库。`);
console.log('运行 npm run dev 即可在 /diary/ 查看。');
