import snapshot from '../data/steam-comments.json';
import syncSnapshot from '../data/steam-sync.json';
import { normalizeSteamProfileUrl, sanitizeSteamContent } from './sanitize-comment.js';

export interface SteamComment {
  id: string;
  name: string;
  profileUrl: string;
  createdAt: string;
  /** null 表示这条在最新一轮抓取里亲眼见到；有值表示是从旧快照合并回来的 */
  lastSeenAt?: string | null;
  avatar: string | null;
  html: string;
}

interface SteamSnapshot {
  profileUrl: string;
  syncedAt: string;
  total: number;
  comments: SteamComment[];
}

const data = snapshot as unknown as SteamSnapshot;

const FALLBACK_PROFILE = 'https://steamcommunity.com/id/IVxiaohangVI/';
const AVATAR_PATH = /^\/steam\/avatars\/[a-z0-9][a-z0-9._-]*\.webp$/i;

// 渲染层不信任 JSON：即使快照被手改或导入坏数据，也只会输出白名单标签
const sanitized: SteamComment[] = data.comments.map((comment) => ({
  ...comment,
  name: typeof comment.name === 'string' && comment.name.trim() ? comment.name : 'Steam 用户',
  profileUrl: normalizeSteamProfileUrl(comment.profileUrl),
  avatar:
    typeof comment.avatar === 'string' && AVATAR_PATH.test(comment.avatar)
      ? comment.avatar
      : null,
  html: sanitizeSteamContent(comment.html),
}));

/**
 * 同一个人只显示一个名字。
 *
 * 某次抓取不完整时，旧留言会带着旧昵称留在快照里，而新留言已经是新昵称；
 * 身份键是 profileUrl，所以渲染时统一取「最近确认过的那条」的名字和头像，
 * 避免同一个人在同一页里出现两个名字。改名本身不会被当成两条留言。
 */
function freshness(comment: SteamComment): number {
  const seen = comment.lastSeenAt ? 0 : 1;
  const created = Date.parse(comment.createdAt);
  return seen * 1e15 + (Number.isFinite(created) ? created : 0);
}

const preferred = new Map<string, SteamComment>();
for (const comment of sanitized) {
  if (!comment.profileUrl) continue;
  const current = preferred.get(comment.profileUrl);
  if (!current || freshness(comment) > freshness(current)) {
    preferred.set(comment.profileUrl, comment);
  }
}

export const steamComments: SteamComment[] = sanitized.map((comment) => {
  const canonical = comment.profileUrl ? preferred.get(comment.profileUrl) : undefined;
  if (!canonical || canonical === comment) return comment;
  return {
    ...comment,
    name: canonical.name,
    avatar: canonical.avatar ?? comment.avatar,
  };
});

/** 快照里有多少条是 partial/empty 时合并回来的、本轮没核对到的 */
export const steamStaleCount = steamComments.filter((comment) => comment.lastSeenAt).length;

export const steamProfileUrl = normalizeSteamProfileUrl(data.profileUrl) || FALLBACK_PROFILE;
export const steamSyncedAt = data.syncedAt;

export type SteamSyncState = 'ok' | 'partial' | 'failed' | 'empty';

export const steamSyncState: SteamSyncState =
  syncSnapshot.state === 'partial' ||
  syncSnapshot.state === 'failed' ||
  syncSnapshot.state === 'empty'
    ? syncSnapshot.state
    : 'ok';

const dateFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function formatSteamTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '时间未知';
  const parts = Object.fromEntries(
    dateFormat.formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${parts.year}.${parts.month}.${parts.day} ${parts.hour}:${parts.minute}`;
}
