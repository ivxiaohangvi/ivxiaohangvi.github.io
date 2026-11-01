// 关于页的状态面板：从同源 Worker 取 Steam 在线状态。
// Worker 侧见 workers/steam-status/；这里只负责渲染、轮询和失败降级。

interface SteamStatusPayload {
  state?: string;
  game?: string | null;
  name?: string | null;
  avatar?: string | null;
  lastLogoff?: number | null;
  updatedAt?: number;
}

interface StatusLook {
  text: string;
  tone: string;
}

const ENDPOINT = new URLSearchParams(location.search).get('steam-api') || '/api/steam-status';
const STORAGE_KEY = 'moxo:steam-status:v1';
const REFRESH_MS = 60_000;
const TIMEOUT_MS = 8000;

// 文案与配色一一对应：颜色走 CSS 的 [data-tone]
const LOOKS: Record<string, StatusLook> = {
  online: { text: '在线', tone: 'online' },
  'in-game': { text: '游戏中', tone: 'game' },
  busy: { text: '忙碌', tone: 'busy' },
  away: { text: '离开', tone: 'away' },
  snooze: { text: '打盹', tone: 'away' },
  trade: { text: '想交易', tone: 'online' },
  play: { text: '想玩游戏', tone: 'online' },
  offline: { text: '离线', tone: 'offline' },
  private: { text: '状态不可见', tone: 'muted' },
  unknown: { text: '读不到', tone: 'muted' },
};

function look(state: string | undefined): StatusLook {
  return LOOKS[state ?? 'unknown'] ?? LOOKS.unknown;
}

function relative(ms: number, now: number): string {
  const diff = now - ms;
  if (!Number.isFinite(diff) || diff < 0) return '刚刚';
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(ms))
    .replace(/\//g, '.');
}

function readCache(): SteamStatusPayload | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SteamStatusPayload) : null;
  } catch {
    return null;
  }
}

function writeCache(payload: SteamStatusPayload): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // 隐私模式或配额满：忽略，下次照样能取
  }
}

function render(panel: HTMLElement, payload: SteamStatusPayload, stale: boolean): void {
  const state = document.querySelector<HTMLElement>('[data-steam="state"]');
  const game = document.querySelector<HTMLElement>('[data-steam="game"]');
  const last = document.querySelector<HTMLElement>('[data-steam="last"]');

  const meta = look(payload.state);
  if (state) {
    state.textContent = meta.text;
    state.dataset.tone = meta.tone;
    state.title = stale ? '这一轮没连上，显示的是上次读到的状态' : '';
  }

  if (game) {
    const playing = payload.state === 'in-game' && payload.game ? payload.game : '—';
    game.textContent = playing;
    game.title = playing === '—' ? '' : playing;
    game.dataset.tone = playing === '—' ? 'muted' : 'game';
  }

  if (last) {
    // 只有离线时「最后在线」才有意义；在线/游戏中显示上次离线时间会让人误会
    const stamp = payload.state === 'offline' ? payload.lastLogoff : null;
    last.textContent = stamp ? relative(stamp, Date.now()) : '—';
    last.dataset.tone = stamp ? 'plain' : 'muted';
    last.title = stamp ? new Date(stamp).toLocaleString('zh-CN', { hour12: false }) : '';
  }

  panel.dataset.stale = stale ? '1' : '0';
  panel.hidden = false;
}

async function request(): Promise<SteamStatusPayload> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as SteamStatusPayload;
  } finally {
    window.clearTimeout(timer);
  }
}

function initPanel(): void {
  const panel = document.querySelector<HTMLElement>('[data-steam-panel]');
  if (!panel || panel.dataset.ready === '1') return;
  panel.dataset.ready = '1';

  let timer = 0;

  const cached = readCache();
  if (cached) render(panel, cached, true);

  const load = async () => {
    try {
      const payload = await request();
      if (payload.state && payload.state !== 'unknown') {
        writeCache(payload);
        render(panel, payload, false);
      } else if (cached) {
        render(panel, cached, true);
      } else {
        render(panel, { state: 'unknown' }, true);
      }
    } catch {
      // 读不到就保留上次的值；没有上次就显示「读不到」
      render(panel, cached ?? { state: 'unknown' }, true);
    }
  };

  const schedule = () => {
    window.clearTimeout(timer);
    if (document.visibilityState !== 'visible') return;
    timer = window.setTimeout(async () => {
      await load();
      schedule();
    }, REFRESH_MS);
  };

  void load().then(schedule);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      void load().then(schedule);
    } else {
      window.clearTimeout(timer);
    }
  });
}

initPanel();
document.addEventListener('astro:page-load', initPanel);
