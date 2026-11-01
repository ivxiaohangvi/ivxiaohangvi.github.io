/**
 * 给文章盖章（OpenTimestamps），并把「当前状态」写成页面要用的清单。
 *
 * 流程：
 *   1. 跑 ots-content.mjs，生成 public/ots/blog/<slug>.txt（被盖章的确切字节）
 *   2. 对每个 .txt：没有 .ots 就 stamp，有但还没确认就 upgrade
 *   3. 有区块高度的，向 mempool.space 查区块哈希与出块时间（带缓存，别每次全量打）
 *   4. 写 src/data/ots.json
 *
 * 这个脚本是「构建前」的一步，不是构建的一部分：离线、超时、日历抽风都不该挡住发版，
 * 所以任何一步失败都只是让页面显示 pending / stale，不会让 build 挂掉。
 *
 * 用法：
 *   node scripts/ots-stamp.mjs            # 增量：该盖的盖、该升的升
 *   node scripts/ots-stamp.mjs --offline  # 只重算清单，不联网
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 时间戳由 opentimestamps-client 提供，命令名按平台取：
 * 优先读 OTS_PYTHON，其次 Windows 上用 python，其他平台用 python3。
 * 也可以设成解释器或 ots 客户端的完整路径。
 */
const PYTHON = process.env.OTS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const TXT_DIR = 'public/ots/blog';
const HISTORY_DIR = join(TXT_DIR, 'history');
const DIGEST_JSON = 'src/data/ots-digest.json';
const MANIFEST = 'src/data/ots.json';
const OFFLINE = process.argv.includes('--offline');
const EXPLORER = 'https://mempool.space';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const readManifest = () => {
  try {
    return JSON.parse(readFileSync(MANIFEST, 'utf8'));
  } catch {
    return null;
  }
};

function runPython(mode, files) {
  if (!files.length) return { ok: true, files: [] };
  const result = spawnSync(PYTHON, ['scripts/ots_stamp.py', mode, ...files], {
    encoding: 'utf8',
    timeout: 240_000,
  });
  const line = String(result.stdout || '').trim().split('\n').filter(Boolean).pop();
  if (!line) {
    console.error(`ots ${mode} 没有输出：${result.stderr || result.error || '未知错误'}`);
    return { ok: false, files: [] };
  }
  try {
    return JSON.parse(line);
  } catch {
    console.error(`ots ${mode} 输出无法解析：${line.slice(0, 200)}`);
    return { ok: false, files: [] };
  }
}

async function blockInfo(height, cache) {
  const key = String(height);
  if (cache[key]) return cache[key];
  try {
    const hashRes = await fetch(`${EXPLORER}/api/block-height/${key}`, { signal: AbortSignal.timeout(12_000) });
    if (!hashRes.ok) return null;
    const hash = (await hashRes.text()).trim();
    const infoRes = await fetch(`${EXPLORER}/api/block/${hash}`, { signal: AbortSignal.timeout(12_000) });
    if (!infoRes.ok) return { hash };
    const info = await infoRes.json();
    const entry = { hash, time: new Date(info.timestamp * 1000).toISOString() };
    cache[key] = entry;
    return entry;
  } catch {
    return null;
  }
}

async function main() {
  mkdirSync(TXT_DIR, { recursive: true });
  mkdirSync(HISTORY_DIR, { recursive: true });

  const digests = existsSync(DIGEST_JSON) ? JSON.parse(readFileSync(DIGEST_JSON, 'utf8')) : {};
  const previous = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { items: {} };
  const cache = previous.blocks ?? {};
  const items = {};

  const slugs = readdirSync(TXT_DIR).filter((name) => name.endsWith('.txt')).map((name) => name.replace(/\.txt$/, ''));

  // 正文改过 → 旧证明已经失效：挪进 history，重新盖
  for (const slug of slugs) {
    const txt = join(TXT_DIR, `${slug}.txt`);
    const ots = `${txt}.ots`;
    const digest = sha256(readFileSync(txt));
    if (digests[slug] && digests[slug] !== digest) {
      console.error(`${slug}: 内容与清单里的 digest 不一致（清单是旧的？）`);
    }
    const prev = previous.items?.[slug];
    if (existsSync(ots) && prev?.digest && prev.digest !== digest) {
      renameSync(ots, join(HISTORY_DIR, `${slug}-${prev.digest.slice(0, 8)}.ots`));
      console.error(`${slug}: 内容变过，旧证明归档到 history/`);
    }
  }

  const missing = slugs.filter((slug) => !existsSync(join(TXT_DIR, `${slug}.txt.ots`)));

  if (!OFFLINE && missing.length) {
    const res = runPython('stamp', missing.map((slug) => join(TXT_DIR, `${slug}.txt`)));
    if (!res.ok) console.error(`盖章失败：${res.error ?? '未知'}`);
  }

  const pendingSlugs = OFFLINE
    ? []
    : slugs.filter((slug) => {
        const prev = previous.items?.[slug];
        return existsSync(join(TXT_DIR, `${slug}.txt.ots`)) && !prev?.height;
      });

  if (pendingSlugs.length) {
    const res = runPython('upgrade', pendingSlugs.map((slug) => join(TXT_DIR, `${slug}.txt`)));
    if (!res.ok) console.error(`升级失败：${res.error ?? '未知'}`);
  }

  for (const slug of slugs) {
    const txt = join(TXT_DIR, `${slug}.txt`);
    const ots = `${txt}.ots`;
    const digest = sha256(readFileSync(txt));
    const base = { digest, content: `/ots/blog/${slug}.txt` };

    if (!existsSync(ots)) {
      items[slug] = { ...base, status: 'pending', stamp: null };
      continue;
    }

    const res = OFFLINE ? { ok: true, files: [{ path: ots, height: previous.items?.[slug]?.height ?? null }] } : runPython('report', [txt]);
    const file = res.files?.find((f) => f.path?.endsWith('.ots'));
    const height = file?.height ?? null;

    if (!height) {
      items[slug] = { ...base, status: 'pending', stamp: `/ots/blog/${slug}.txt.ots` };
      continue;
    }

    const info = await blockInfo(height, cache);
    items[slug] = {
      ...base,
      status: 'confirmed',
      height,
      blockHash: info?.hash ?? null,
      blockTime: info?.time ?? null,
      merkleRoot: file?.msg ?? null,
      stamp: `/ots/blog/${slug}.txt.ots`,
      explorer: info?.hash ? `${EXPLORER}/block/${info.hash}` : null,
    };
  }

  // generatedAt 只在「内容真的变了」时更新：CI 每 6 小时跑一次，
  // 每次刷新时间戳会让 src/data/ots.json 永远有 diff，进而每 6 小时产生一个空提交。
  const prevManifest = readManifest();
  const changed =
    !prevManifest ||
    prevManifest.explorer !== EXPLORER ||
    JSON.stringify(prevManifest.items) !== JSON.stringify(items) ||
    JSON.stringify(prevManifest.blocks) !== JSON.stringify(cache);
  const generatedAt = changed || !prevManifest?.generatedAt ? new Date().toISOString() : prevManifest.generatedAt;

  writeFileSync(
    MANIFEST,
    `${JSON.stringify({ generatedAt, explorer: EXPLORER, blocks: cache, items }, null, 2)}\n`,
    'utf8',
  );

  const confirmed = Object.values(items).filter((i) => i.status === 'confirmed').length;
  console.log(JSON.stringify({ ok: true, total: slugs.length, confirmed, pending: slugs.length - confirmed }));
}

await main();
