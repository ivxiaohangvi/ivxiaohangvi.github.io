/**
 * Steam 同步的纯逻辑：状态判定、旧数据合并、删除判定。
 * 单独放这里是为了能在不联网的情况下单测。
 *
 * 约定：
 * - 一条留言的身份是 Steam 的评论 id，昵称/头像只是它的属性。
 * - `lastSeenAt` 为 null 表示「这次快照里亲眼见到过」；有值表示这是上一轮
 *   合并回来的旧留言，值就是它最后一次被确认的时间。
 * - **只有完整抓取（ok）才允许把没再出现的留言判定为已删除**；partial / empty
 *   一律保留旧留言，宁可显示旧的，也不要因为一次网络抖动把留言板清空。
 */

const STATES = new Set(['ok', 'partial', 'failed', 'empty']);
const REASONS = new Set(['fetch', 'empty', 'incomplete']);

export function classifySteamSync({ freshCount, total, complete }) {
  const count = Number(freshCount);
  const expected = Number(total);

  if (!Number.isFinite(count) || count <= 0) return 'failed';
  if (complete !== true) return 'partial';
  if (Number.isFinite(expected) && expected > 0 && count < expected) return 'partial';
  return 'ok';
}

/**
 * 把本轮抓到的留言和旧快照对齐。
 *
 * - `state === 'ok'`：这份快照就是权威结果，没出现的留言视为已删除。
 * - 其他状态：按 id 合并，旧留言保留 `lastSeenAt`，新抓到的条目 `lastSeenAt` 置空。
 */
export function reconcileComments({
  fresh = [],
  previous = [],
  state,
  now = new Date().toISOString(),
  previousSyncedAt = '',
}) {
  const present = fresh.filter((comment) => comment?.id);

  if (state === 'ok') {
    return present.map((comment) => ({ ...comment, lastSeenAt: null }));
  }

  const merged = new Map();

  for (const comment of previous) {
    if (!comment?.id) continue;
    merged.set(comment.id, {
      ...comment,
      lastSeenAt: comment.lastSeenAt ?? previousSyncedAt ?? now,
    });
  }

  for (const comment of present) {
    merged.set(comment.id, { ...comment, lastSeenAt: null });
  }

  return [...merged.values()];
}

export function syncStatus(state, reason = '') {
  if (!STATES.has(state)) throw new Error(`未知同步状态：${state}`);
  if (state === 'ok') return { state: 'ok' };
  if (!REASONS.has(reason)) throw new Error(`未知同步原因：${reason}`);
  return { state, reason };
}
