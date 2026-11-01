/**
 * 为每篇文章生成「规范化内容」文本，作为 OpenTimestamps 的盖章对象。
 *
 * 为什么不是直接盖 HTML：改一次 CSS / 换一次模板，整站 HTML 全变，
 * 已有证明就集体失效了。这里只装内容本身（标题、日期、标签、正文），
 * 样式和排版随便改，证明照样有效；只有正文真的变了，digest 才变。
 *
 * 输出：
 *   public/ots/blog/<slug>.txt          被盖章的确切字节（读者可下载后自行 verify）
 *   src/data/ots-digest.json            每篇的 sha256，构建时用来判断证明是否过期
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BLOG_DIR = 'src/content/blog';
const OUT_DIR = 'public/ots/blog';
const DIGEST_JSON = 'src/data/ots-digest.json';
const RECORD_DIR = 'scripts/ots-records';

/** 极简 frontmatter 解析：只认 blog 用得到的那几个字段 */
function parseFrontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { data: {}, body: raw };
  const data = {};
  let key = null;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      const value = kv[2].trim();
      if (value.startsWith('[') && value.endsWith(']')) {
        data[key] = value
          .slice(1, -1)
          .split(',')
          .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
          .filter(Boolean);
      } else {
        data[key] = value.replace(/^['"]|['"]$/g, '');
      }
    } else if (key && /^\s+-\s+/.test(line)) {
      data[key] = `${data[key]}`.length ? data[key] : '';
      const items = Array.isArray(data[key]) ? data[key] : [];
      items.push(line.replace(/^\s+-\s+/, '').trim().replace(/^['"]|['"]$/g, ''));
      data[key] = items;
    }
  }
  return { data, body: raw.slice(match[0].length) };
}

/** 正文规范化：统一换行、去掉行尾空白与首尾空行，其余字节原样保留 */
function normalizeBody(body) {
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

function canonical(entry) {
  const tags = Array.isArray(entry.tags) ? entry.tags.join(', ') : (entry.tags ?? '');
  return [
    'moxo-blog-ots/1',
    `slug: ${entry.slug}`,
    `title: ${entry.title}`,
    `description: ${entry.description ?? ''}`,
    `pubDate: ${entry.pubDate}`,
    `updatedDate: ${entry.updatedDate ?? ''}`,
    `tags: ${tags}`,
    '',
    'body:',
    entry.body,
    '',
  ].join('\n');
}

const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(RECORD_DIR, { recursive: true });

const files = readdirSync(BLOG_DIR).filter((name) => name.endsWith('.md'));
const digests = {};
const written = [];

for (const file of files) {
  const slug = file.replace(/\.md$/, '');
  const raw = readFileSync(join(BLOG_DIR, file), 'utf8');
  const { data, body } = parseFrontmatter(raw);
  if (String(data.draft) === 'true') continue;

  const text = canonical({
    slug,
    title: data.title ?? slug,
    description: data.description,
    pubDate: data.pubDate,
    updatedDate: data.updatedDate,
    tags: data.tags,
    body: normalizeBody(body),
  });

  const digest = sha256(text);
  digests[slug] = digest;

  const target = join(OUT_DIR, `${slug}.txt`);
  const changed = !existsSync(target) || readFileSync(target, 'utf8') !== text;
  if (changed) writeFileSync(target, text, 'utf8');
  written.push({ slug, digest, changed });
}

writeFileSync(DIGEST_JSON, `${JSON.stringify(digests, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ok: true, files: written.length, changed: written.filter((w) => w.changed).map((w) => w.slug) }));
