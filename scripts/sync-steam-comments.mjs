/**
 * 把 Steam 公开留言板的留言同步成站内快照。
 *
 *   npm run sync:steam                抓取最新留言
 *   npm run sync:steam -- --input x   从保存下来的 JSON/HTML 解析（离线导入）
 *   npm run sync:steam -- --skip-avatars  只更新文字，不动头像
 *
 * 抓取失败时不覆盖留言快照，只把失败状态单独记到 steam-sync.json；
 * 抓取不完整时保留旧留言并标记 partial；一条都没读到时记 empty 而不是 failed；
 * 只有完整抓取（ok）才会把没再出现的留言判为已删除；头像下载失败则沿用已有文件，
 * 同步结束后清理不再被任何留言引用的头像。
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {
  decodeEntities,
  normalizeSteamProfileUrl,
  normalizeSteamUrl,
  sanitizeSteamContent,
} from '../src/lib/sanitize-comment.js';
import {
  classifySteamSync,
  reconcileComments,
  syncStatus,
} from './lib/steam-sync.mjs';

const ROOT = process.cwd();
const STEAM_ID = '76561198311103824';
const PROFILE_URL = 'https://steamcommunity.com/id/IVxiaohangVI/';
const ENDPOINT = `https://steamcommunity.com/comment/Profile/${STEAM_ID}/`;
const PAGE_SIZE = 50;
const DATA_FILE = path.join(ROOT, 'src/data/steam-comments.json');
const SYNC_STATUS_FILE = path.join(ROOT, 'src/data/steam-sync.json');
const AVATAR_DIR = path.join(ROOT, 'public/steam/avatars');
const TMP_FILE = path.join(ROOT, 'tmp/steam-last-render.json');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const args = process.argv.slice(2);
const inputFile = args.includes('--input') ? args[args.indexOf('--input') + 1] : '';
const skipAvatars = args.includes('--skip-avatars');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let avatarWrites = 0;

function fail(message) {
  console.error(`\n[steam] ${message}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- 抓取 */

async function request(url, tries = 3) {
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': UA,
          accept: 'application/json, text/javascript, */*; q=0.01',
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          referer: PROFILE_URL + 'allcomments',
          'x-requested-with': 'XMLHttpRequest',
        },
        signal: AbortSignal.timeout(25_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      const reason = err.cause?.message ? `${err.message}（${err.cause.message}）` : err.message;
      if (attempt === tries) throw err;
      console.warn(`[steam] ${url} 第 ${attempt} 次失败：${reason}`);
      await sleep(1200 * attempt);
    }
  }
}

async function fetchPages() {
  const all = [];
  let total = 0;
  let complete = true;
  let page = 0;
  let start = 0;

  for (; page < 20; page += 1, start += PAGE_SIZE) {
    let json;
    try {
      const raw = await request(`${ENDPOINT}?start=${start}&count=${PAGE_SIZE}`);
      json = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch (err) {
      if (page === 0) throw err;
      console.warn(`[steam] 第 ${page + 1} 页抓取失败，保留其余页：${err.message}`);
      complete = false;
      break;
    }

    await mkdir(path.dirname(TMP_FILE), { recursive: true });
    if (page === 0) await writeFile(TMP_FILE, JSON.stringify(json, null, 2));

    if (json.success !== true) {
      if (page === 0) throw new Error('Steam 返回 success=false，可能被限流或页面改版');
      console.warn(`[steam] 第 ${page + 1} 页被 Steam 拒绝，保留其余页`);
      complete = false;
      break;
    }

    const pageComments = parseComments(json.comments_html || '');
    all.push(...pageComments);
    total = Number(json.total_count) || total;

    if (pageComments.length === 0) break;
    if (total && all.length >= total) break;
    if (page > 0 || pageComments.length < PAGE_SIZE) await sleep(1000);
    else await sleep(1400);
  }

  // 跑到页数上限还没自然收尾，说明后面可能还有内容
  if (page === 20) complete = false;

  const seen = new Set();
  const comments = all.filter((comment) => {
    if (seen.has(comment.id)) return false;
    seen.add(comment.id);
    return true;
  });

  if (total && comments.length < total) {
    console.warn(
      `[steam] Steam 报告 ${total} 条，实际只拿到 ${comments.length} 条，按不完整处理`
    );
    complete = false;
  }

  return { comments, total, complete };
}

/* ---------------------------------------------------------------- 解析 */

const COMMENT_RE =
  /<div\b[^>]*class="commentthread_comment[^"]*"[^>]*id="comment_(\d+)"[^>]*>/g;

function getAttr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : '';
}

function safeAvatarSource(raw) {
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    if (!/(^|\.)(steamstatic\.com|queniuqe\.com)$/i.test(url.hostname)) return '';
    return url.href;
  } catch {
    return '';
  }
}

function parseComment(block, id) {
  const avatarBlock = block.replace(
    /<div class="profile_avatar_frame">[\s\S]*?<\/div>/,
    ''
  );

  const avatarTag = avatarBlock
    .match(/<div\b[^>]*class="[^"]*commentthread_comment_avatar[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1]
    ?.match(/<img\b[^>]*>/)?.[0];
  const avatarSource = safeAvatarSource(
    avatarTag
      ? normalizeSteamUrl(getAttr(avatarTag, 'src') || getAttr(avatarTag, 'srcset').split(/\s+/)[0])
      : ''
  );

  const authorTag = block.match(
    /<a\b[^>]*class="[^"]*commentthread_author_link[^"]*"[^>]*>([\s\S]*?)<\/a>/
  );
  const authorHref = authorTag ? normalizeSteamUrl(getAttr(authorTag[0].split('>')[0], 'href')) : '';
  const authorInner = authorTag?.[1]?.match(/<bdi[^>]*>([\s\S]*?)<\/bdi>/)?.[1] ?? authorTag?.[1] ?? '';
  const name = decodeEntities(authorInner.replace(/<[^>]*>/g, '')).trim();

  const profileUrl = normalizeSteamProfileUrl(authorHref);

  const timestampBlock = block.match(
    /<div\b[^>]*class="[^"]*commentthread_comment_timestamp[^"]*"[^>]*data-timestamp="(\d+)"[^>]*>/
  );
  const seconds = timestampBlock ? Number(timestampBlock[1]) : NaN;

  const contentMatch = block.match(
    /<div class="commentthread_comment_text"[^>]*>([\s\S]*?)<\/div>\s*<div class="comment_footer_ctn">/
  ) ?? block.match(/<div class="commentthread_comment_text"[^>]*>([\s\S]*?)<\/div>/);
  const html = contentMatch ? sanitizeSteamContent(contentMatch[1]) : '';

  if (!id || !name || !Number.isFinite(seconds)) return null;

  return {
    id,
    name: name || 'Steam 用户',
    profileUrl,
    createdAt: new Date(seconds * 1000).toISOString(),
    avatarSource,
    avatar: null,
    html,
  };
}

function parseComments(html) {
  const matches = [...html.matchAll(COMMENT_RE)];
  return matches
    .map((match, index) => {
      const end = index + 1 < matches.length ? matches[index + 1].index : html.length;
      return parseComment(html.slice(match.index, end), match[1]);
    })
    .filter(Boolean);
}

/* ---------------------------------------------------------------- 头像 */

function avatarFileFor(comment) {
  const profile = comment.profileUrl || comment.name;
  const numeric = profile.match(/\/profiles\/(\d+)/)?.[1];
  if (numeric) return `${numeric}.webp`;
  const slug = profile
    .replace(/^.*\/id\//, '')
    .replace(/[^a-z0-9_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const hash = createHash('sha1').update(profile).digest('hex').slice(0, 8);
  return `${slug || 'anon'}-${hash}.webp`;
}

async function cacheAvatar(comment, previous) {
  const fileName = avatarFileFor(comment);
  const relPath = `/steam/avatars/${fileName}`;
  const absPath = path.join(AVATAR_DIR, fileName);
  const previousAbs = previous?.avatar ? path.join(ROOT, 'public', previous.avatar) : '';

  const fallback = () => {
    if (existsSync(absPath)) return relPath;
    if (previousAbs && existsSync(previousAbs)) return previous.avatar;
    return null;
  };

  if (skipAvatars) return fallback();
  if (!comment.avatarSource) return fallback();
  if (existsSync(absPath) && previous?.avatarSource === comment.avatarSource) return relPath;

  try {
    const res = await fetch(comment.avatarSource, {
      headers: { 'user-agent': UA, referer: PROFILE_URL },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const input = Buffer.from(await res.arrayBuffer());
    const webp = await sharp(input, { animated: false })
      .resize(128, 128, { fit: 'cover' })
      .webp({ quality: 82 })
      .toBuffer();

    await mkdir(AVATAR_DIR, { recursive: true });
    await writeFile(absPath, webp);
    avatarWrites += 1;
    return relPath;
  } catch (err) {
    console.warn(`[steam] 头像下载失败（${comment.name}）：${err.message}`);
    return fallback();
  }
}

/**
 * 清掉不再被任何留言引用的头像。
 * 只在拿到权威快照（ok）后跑；partial / empty 时快照里仍混着旧留言，
 * 引用集合本身就是旧的，清理不会误伤，但没有必要多扫一遍。
 */
async function gcAvatars(comments) {
  if (inputFile || skipAvatars) return;
  if (!existsSync(AVATAR_DIR)) return;

  const keep = new Set();
  for (const comment of comments) {
    if (typeof comment.avatar !== 'string') continue;
    if (!comment.avatar.startsWith('/steam/avatars/')) continue;
    keep.add(path.basename(comment.avatar));
  }

  let removed = 0;
  for (const name of await readdir(AVATAR_DIR)) {
    if (!name.toLowerCase().endsWith('.webp')) continue;
    if (keep.has(name)) continue;
    await unlink(path.join(AVATAR_DIR, name));
    removed += 1;
  }

  if (removed) console.log(`[steam] 清理未引用头像 ${removed} 个（仍在使用 ${keep.size} 个）`);
}

/* ---------------------------------------------------------------- 主流程 */

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeSyncStatus(status) {
  await mkdir(path.dirname(SYNC_STATUS_FILE), { recursive: true });
  await writeFile(SYNC_STATUS_FILE, `${JSON.stringify(status, null, 2)}\n`);
}

async function recordSyncFailure(reason) {
  if (inputFile) return;
  const previousStatus = await readJson(SYNC_STATUS_FILE);
  const nextStatus = syncStatus('failed', reason);
  if (JSON.stringify(previousStatus) === JSON.stringify(nextStatus)) return;
  try {
    await writeSyncStatus(nextStatus);
    console.log(`[steam] 已记录失败状态（${reason}），留言快照保持不变`);
  } catch (err) {
    console.error(`[steam] 失败状态写入失败：${err.message}`);
  }
}

async function main() {
  const previous = await readJson(DATA_FILE);
  const previousById = new Map((previous?.comments ?? []).map((comment) => [comment.id, comment]));

  let comments;
  let complete = true;
  let total = 0;

  if (inputFile) {
    const inputPath = path.resolve(ROOT, inputFile);
    if (!existsSync(inputPath)) fail(`找不到输入文件：${inputFile}`);
    const raw = await readFile(inputPath, 'utf8');
    let html = raw;
    try {
      const json = JSON.parse(raw.replace(/^\uFEFF/, ''));
      html = json.comments_html ?? '';
      total = Number(json.total_count) || 0;
      if (!html) fail('输入 JSON 里没有 comments_html');
    } catch (err) {
      if (!/<div\b[^>]*class="commentthread_comment/.test(raw)) {
        fail(`输入文件既不是评论 JSON，也不像留言页 HTML：${err.message}`);
      }
    }
    comments = parseComments(html);
    console.log(`[steam] 从 ${inputFile} 解析到 ${comments.length} 条留言`);
  } else {
    try {
      ({ comments, total, complete } = await fetchPages());
    } catch (err) {
      await recordSyncFailure('fetch');
      fail(`抓取失败，保留旧快照：${err.message}`);
    }
  }

  if (comments.length === 0) {
    // 「一条也没读到」和「抓取失败」是两件事：前者可能是留言板被清空，也可能是
    // Steam 暂时限流。保留上一份快照，只把状态记成 empty，让页面自己说明情况。
    if (previous?.comments?.length) {
      const nextStatus = syncStatus('empty', 'empty');
      const previousStatus = await readJson(SYNC_STATUS_FILE);
      if (JSON.stringify(previousStatus) !== JSON.stringify(nextStatus)) {
        await writeSyncStatus(nextStatus);
      }
      console.log(
        `[steam] 这次一条留言也没读到，保留上一份快照（${previous.comments.length} 条）并标记 empty`
      );
      return;
    }

    // 从来就没有过留言：写一份空快照，状态仍然是 ok。
    await mkdir(path.dirname(DATA_FILE), { recursive: true });
    await writeFile(
      DATA_FILE,
      `${JSON.stringify(
        {
          steamId: STEAM_ID,
          profileUrl: PROFILE_URL,
          syncedAt: new Date().toISOString(),
          total: 0,
          comments: [],
        },
        null,
        2
      )}\n`
    );
    await writeSyncStatus(syncStatus('ok'));
    console.log('[steam] 留言板是空的，已写入空快照');
    return;
  }

  const state = inputFile
    ? 'ok'
    : classifySteamSync({ freshCount: comments.length, total, complete });

  const beforeMerge = comments.length;
  comments = reconcileComments({
    fresh: comments,
    previous: previous?.comments ?? [],
    state,
    previousSyncedAt: previous?.syncedAt ?? '',
  });

  if (state !== 'ok' && comments.length > beforeMerge) {
    console.log(
      `[steam] 抓取不完整（${state}），本次 ${beforeMerge} 条，与旧快照合并后共 ${comments.length} 条`
    );
  } else if (state === 'ok') {
    const removed = (previous?.comments?.length ?? 0) - beforeMerge;
    if (removed > 0) console.log(`[steam] 完整抓取下已移除 ${removed} 条不再存在的留言`);
  }

  comments.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  for (const comment of comments) {
    const previousComment = previousById.get(comment.id);
    comment.avatar = await cacheAvatar(comment, previousComment);
  }

  const commentsJson = JSON.stringify(comments);
  const unchanged = previous?.comments && JSON.stringify(previous.comments) === commentsJson;

  const data = {
    steamId: STEAM_ID,
    profileUrl: PROFILE_URL,
    syncedAt: unchanged ? previous.syncedAt : new Date().toISOString(),
    total: comments.length,
    comments,
  };

  await mkdir(path.dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, `${JSON.stringify(data, null, 2)}\n`);

  await writeSyncStatus(
    state === 'ok' ? syncStatus('ok') : syncStatus(state, 'incomplete')
  );

  await gcAvatars(comments);

  const note = unchanged ? '内容无变化' : `写入头像 ${avatarWrites} 个`;
  console.log(
    `[steam] 已写入 ${path.relative(ROOT, DATA_FILE)}：${comments.length} 条留言（${note}；Steam 报告 ${total || '?'} 条；状态 ${state}）`
  );
}

main().catch((err) => fail(err.stack || err.message));
