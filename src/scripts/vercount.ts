/**
 * Vercount 访问统计（https://www.vercount.one/）。
 *
 * 计数按域名归属，moxo.cc 已经做过域名认证，所以只在正式域名下启用：
 * 本地 dev / preview（127.0.0.1、localhost）直接不请求，免得开发时的刷新被算成线上访问。
 *
 * 请求形状与官方脚本一致（POST /api/v2/log，body { url, isNewUv }），
 * 区别是手动触发：官方脚本只在 DOMContentLoaded 跑一次，本站又开了 ClientRouter，
 * 站内跳转后它不会再执行，所以这里挂在 astro:page-load 上逐页重算。
 *
 * 页面里放这些 id 就会被自动填数（没有的跳过）：
 *   #vercount_value_site_pv / #vercount_value_site_uv / #vercount_value_page_pv
 * 容器用 [data-vercount] 标出，数字到位前保持 hidden，读不到就不显示破数字。
 */

const ENDPOINT = 'https://events.vercount.one/api/v2/log';
const CACHE_KEY = 'visitorCountData';
const UV_COOKIE_PREFIX = 'vercount_uv_';
const REQUEST_TIMEOUT = 5_000;
const DEDUPE_WINDOW = 2_000;

const ENABLED = /(^|\.)moxo\.cc$/i.test(window.location.hostname);

type StatKey = 'site_pv' | 'page_pv' | 'site_uv';
type Stats = Record<StatKey, number>;

const KEYS: StatKey[] = ['site_pv', 'page_pv', 'site_uv'];

let lastUrl = '';
let lastAt = 0;

function numberOrZero(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalize(payload: unknown): Stats {
  const record = payload as { status?: string; data?: Record<string, unknown> } & Record<string, unknown>;
  const source =
    (record?.status === 'success' || record?.status === 'error') && record.data ? record.data : record;
  return {
    site_pv: numberOrZero(source?.site_pv),
    page_pv: numberOrZero(source?.page_pv),
    site_uv: numberOrZero(source?.site_uv),
  };
}

function elementFor(key: StatKey): HTMLElement | null {
  return (
    document.getElementById(`vercount_value_${key}`) ??
    document.getElementById(`busuanzi_value_${key}`)
  );
}

function containers(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-vercount]'));
}

function render(stats: Partial<Stats>): number {
  let filled = 0;
  for (const key of KEYS) {
    const element = elementFor(key);
    const value = stats[key];
    if (!element || typeof value !== 'number') continue;
    element.textContent = value.toLocaleString('zh-CN');
    filled += 1;
  }
  return filled;
}

function reveal(): void {
  for (const box of containers()) box.hidden = false;
}

function conceal(): void {
  for (const box of containers()) box.hidden = true;
}

function readCache(): { url: string; stats: Stats } | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { url?: string; stats?: Stats } & Partial<Stats>;
    if (parsed?.stats) return { url: String(parsed.url ?? ''), stats: parsed.stats };
    return { url: '', stats: normalize(parsed) };
  } catch {
    return null;
  }
}

function writeCache(url: string, stats: Stats): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ url, stats }));
  } catch {
    /* 无痕模式 / 存储被禁用时不缓存，不影响计数 */
  }
}

function uvCookieName(): string {
  return `${UV_COOKIE_PREFIX}${window.location.host.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

function hasUvCookie(): boolean {
  return document.cookie.split('; ').some((item) => item === `${uvCookieName()}=1`);
}

function markUvCookie(): void {
  document.cookie = `${uvCookieName()}=1; path=/; max-age=31536000; samesite=lax`;
}

async function log(url: string): Promise<Stats | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  const freshVisitor = !hasUvCookie();
  if (freshVisitor) markUvCookie();

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, isNewUv: freshVisitor }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return normalize(await response.json());
  } catch (error) {
    if ((error as Error)?.name !== 'AbortError') {
      console.warn('[vercount] 统计请求失败：', error);
    }
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

async function run(): Promise<void> {
  if (!ENABLED) return;

  const url = window.location.href;
  const now = Date.now();
  // 首次加载时 boot 与 astro:page-load 会挨着触发两次，留一个去重窗口。
  if (url === lastUrl && now - lastAt < DEDUPE_WINDOW) return;
  lastUrl = url;
  lastAt = now;

  conceal();

  const cached = readCache();
  if (cached) {
    let filled = render({ site_pv: cached.stats.site_pv, site_uv: cached.stats.site_uv });
    // page_pv 是逐页的，只有同一 URL 的缓存才敢拿来顶一下。
    if (cached.url === url) filled += render({ page_pv: cached.stats.page_pv });
    if (filled > 0) reveal();
  }

  const fresh = await log(url);
  if (!fresh) return;

  if (render(fresh) > 0) reveal();
  writeCache(url, fresh);
}

function boot(): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void run(), { once: true });
  } else {
    void run();
  }
  document.addEventListener('astro:page-load', () => void run());
}

boot();
