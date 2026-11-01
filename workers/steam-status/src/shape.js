// 把 Steam 的 player summary 折成前端要用的最小结构。
// 单独放一个文件，方便用 node --test 直接验证，不用起 wrangler。
//
// personastate: 0 离线 · 1 在线 · 2 忙碌 · 3 离开 · 4 打盹 · 5 想交易 · 6 想游戏
// 有 gameextrainfo 时以「游戏中」为准（Steam 自己的客户端也是这么显示的）。

const PERSONA_STATES = ['offline', 'online', 'busy', 'away', 'snooze', 'trade', 'play'];

export const PUBLIC_VISIBILITY = 3;

/**
 * @param {Record<string, unknown> | null | undefined} player
 * @param {number} now
 */
export function shapePlayer(player, now = Date.now()) {
  if (!player || typeof player !== 'object') {
    return { state: 'unknown', updatedAt: now };
  }

  const raw = player;
  const visible = Number(raw.communityvisibilitystate) === PUBLIC_VISIBILITY;
  const game = typeof raw.gameextrainfo === 'string' && raw.gameextrainfo.trim() ? raw.gameextrainfo.trim() : null;

  let state;
  if (!visible) {
    // 资料私密时 Steam 只会回 0，分不清是真离线还是藏起来了
    state = 'private';
  } else if (game) {
    state = 'in-game';
  } else {
    const index = Number(raw.personastate);
    state = Number.isInteger(index) && PERSONA_STATES[index] ? PERSONA_STATES[index] : 'unknown';
  }

  const lastLogoff = Number(raw.lastlogoff);

  return {
    state,
    game,
    name: typeof raw.personaname === 'string' ? raw.personaname : null,
    avatar: typeof raw.avatarfull === 'string' ? raw.avatarfull : null,
    // Steam 用秒，前端统一用毫秒
    lastLogoff: Number.isFinite(lastLogoff) && lastLogoff > 0 ? lastLogoff * 1000 : null,
    updatedAt: now,
  };
}
