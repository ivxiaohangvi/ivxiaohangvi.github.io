// 暗房模型（infinity.glb，约 4.9MB）的下载状态机：空闲预取、Range 断点续传、Cache Storage 持久化。
// 全站共享一份实例（挂在 globalThis 上，即使打包成两个 chunk 也只跑一次）；
// 进暗房时前台 awaitDarkroomModel() 复用同一份已下载的字节，不会重复下载。

const MODEL_VERSION = 'v2';
const MODEL_PATH = `${import.meta.env.BASE_URL}models/infinity.glb`;
const CACHE_NAME = `moxo-darkroom-${MODEL_VERSION}`;

// 首屏资源落地后才允许后台下载；之后每次恢复都要求一段无交互静默期
const START_DELAY_MS = 6000;
const QUIET_MS = 4000;

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];

export type ModelProgress = (loaded: number, total: number) => void;

export interface ModelResult {
  buffer: ArrayBuffer;
  fromCache: boolean;
}

interface Waiter {
  resolve: (result: ModelResult) => void;
  reject: (error: unknown) => void;
  onProgress?: ModelProgress;
}

interface Download {
  chunks: Uint8Array[];
  received: number;
  total: number;
  controller: AbortController | null;
  foreground: boolean;
  /** 用户已表露去暗房的意图：跳过空闲等待，也不因滚动/悬停让路 */
  eager: boolean;
  readyAt: number;
  settled: boolean;
  failed: boolean;
  buffer: ArrayBuffer | null;
  fromCache: boolean;
}

interface DarkroomState {
  dl: Download;
  waiters: Waiter[];
  lastActivity: number;
  running: boolean;
}

type GlobalWithDarkroom = typeof globalThis & { __moxoDarkroom?: DarkroomState };

function makeDownload(): Download {
  return {
    chunks: [],
    received: 0,
    total: 0,
    controller: null,
    foreground: false,
    eager: false,
    readyAt: Date.now() + START_DELAY_MS,
    settled: false,
    failed: false,
    buffer: null,
    fromCache: false,
  };
}

function state(): DarkroomState {
  const g = globalThis as GlobalWithDarkroom;
  if (!g.__moxoDarkroom) {
    const dl = makeDownload();
    const s: DarkroomState = { dl, waiters: [], lastActivity: Date.now(), running: false };
    g.__moxoDarkroom = s;
    attachActivityListeners(s);
  }
  return g.__moxoDarkroom;
}

function attachActivityListeners(s: DarkroomState): void {
  const mark = () => {
    s.lastActivity = Date.now();
    // 用户回来了，后台下载立刻让路；前台与意图预取不受影响
    if (!s.dl.foreground && !s.dl.eager) s.dl.controller?.abort('activity');
  };
  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, mark, { passive: true, capture: true });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (!s.dl.foreground) s.dl.controller?.abort('hidden');
    } else {
      s.lastActivity = Date.now();
    }
  });

  // 悬停/聚焦到链接说明要走导航了，别和下一页的资源抢带宽
  const watchNavIntent = (event: Event) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest('a')) mark();
  };
  document.addEventListener('pointerover', watchNavIntent, { passive: true });
  document.addEventListener('focusin', watchNavIntent);

  window.addEventListener('offline', () => s.dl.controller?.abort('offline'));
  window.addEventListener('pagehide', () => s.dl.controller?.abort('pagehide'));
  document.addEventListener('astro:before-swap', () => {
    if (!s.dl.foreground) s.dl.controller?.abort('swap');
  });
}

function cacheKey(): string {
  return new URL(`${MODEL_PATH}?v=${MODEL_VERSION}`, location.href).href;
}

function cacheAvailable(): boolean {
  return typeof caches !== 'undefined';
}

// 只判断命中与否：后台预取不该为了检查缓存而把 4.9MB 读进内存
async function hasCachedModel(): Promise<boolean> {
  if (!cacheAvailable()) return false;
  try {
    return !!(await (await caches.open(CACHE_NAME)).match(cacheKey()));
  } catch {
    return false;
  }
}

async function readCachedModel(): Promise<ArrayBuffer | null> {
  if (!cacheAvailable()) return null;
  try {
    const hit = await (await caches.open(CACHE_NAME)).match(cacheKey());
    return hit ? await hit.arrayBuffer() : null;
  } catch {
    return null;
  }
}

async function writeCache(buffer: ArrayBuffer): Promise<void> {
  if (!cacheAvailable()) return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(cacheKey(), new Response(buffer, { headers: { 'Content-Type': 'model/gltf-binary' } }));
    // 换模型后旧版本键要清掉，不然 4.9MB 的孤儿文件会一直占着配额
    const stale = (await caches.keys()).filter((name) => name.startsWith('moxo-darkroom-') && name !== CACHE_NAME);
    await Promise.all(stale.map((name) => caches.delete(name)));
  } catch {
    // 配额不足或无痕模式：静默放弃，进暗房走正常网络加载
  }
}

// 低网速/省流量时根本不后台预取，留给进暗房时的正常加载兜底
function isSlowLink(): boolean {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (!conn) return false;
  if (conn.saveData) return true;
  return /2g/.test(conn.effectiveType ?? '');
}

function isIdle(s: DarkroomState): boolean {
  return Date.now() - s.lastActivity > QUIET_MS && !document.hidden && navigator.onLine && !isSlowLink();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function idleSlot(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, opts: { timeout: number }) => number })
      .requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 2000 });
    else resolve();
  });
}

function notify(s: DarkroomState): void {
  for (const waiter of s.waiters) waiter.onProgress?.(s.dl.received, s.dl.total);
}

function settle(s: DarkroomState, buffer: ArrayBuffer, fromCache: boolean): void {
  const dl = s.dl;
  dl.buffer = buffer;
  dl.fromCache = fromCache;
  dl.settled = true;
  dl.chunks = [];
  dl.controller = null;
  const pending = s.waiters.splice(0);
  for (const waiter of pending) waiter.resolve({ buffer, fromCache });
}

function fail(s: DarkroomState, error: unknown): void {
  s.dl.failed = true;
  s.dl.controller = null;
  const pending = s.waiters.splice(0);
  for (const waiter of pending) waiter.reject(error);
}

function reset(s: DarkroomState): void {
  s.dl = makeDownload();
  s.dl.readyAt = 0;
}

function combine(dl: Download): ArrayBuffer {
  const buffer = new Uint8Array(dl.received);
  let offset = 0;
  for (const chunk of dl.chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
}

async function attempt(s: DarkroomState): Promise<void> {
  const dl = s.dl;
  const controller = new AbortController();
  dl.controller = controller;

  const headers: Record<string, string> = {};
  // 不看 Accept-Ranges 头（有服务端支持却不声明），直接用状态码判断：206 续传、200 重来
  if (dl.received > 0) headers.Range = `bytes=${dl.received}-`;

  try {
    const response = await fetch(MODEL_PATH, { headers, signal: controller.signal });

    // 416：已收字节数等于或超过文件长度，说明上一次其实下完了，丢弃重来最稳
    if (response.status === 416) {
      dl.chunks = [];
      dl.received = 0;
      return;
    }
    if (!response.ok) throw new Error(`暗房模型请求失败：${response.status}`);
    if (!response.body) throw new Error('暗房模型响应没有可读正文');

    const declared = Number(response.headers.get('Content-Length') ?? 0);
    if (response.status === 206) {
      dl.total = dl.received + declared;
    } else {
      // 200：服务端忽略了 Range，之前收到的部分字节不能拼接
      dl.chunks = [];
      dl.received = 0;
      dl.total = declared;
    }

    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      dl.chunks.push(value);
      dl.received += value.byteLength;
      notify(s);
    }

    // total 为 0 表示长度未知，正文读完即算完成
    if (dl.total > 0 && dl.received < dl.total) return; // 传输被截断，下一轮用 Range 续
    settle(s, combine(dl), false);
    void writeCache(dl.buffer!);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      // 被空闲策略打断：已下载的字节留在内存里，恢复时接着下
      dl.controller = null;
      return;
    }
    fail(s, error);
  }
}

async function run(s: DarkroomState): Promise<void> {
  while (!s.dl.settled && !s.dl.failed) {
    if (Date.now() < s.dl.readyAt) {
      await sleep(250);
      continue;
    }
    if (!s.dl.foreground) {
      if (s.dl.eager) {
        // 意图预取不等空闲，但省流量/离线/后台标签页仍然让路
        if (document.hidden || !navigator.onLine || isSlowLink()) {
          await sleep(500);
          continue;
        }
      } else {
        if (!isIdle(s)) {
          await sleep(250);
          continue;
        }
        await idleSlot();
        if (!s.dl.foreground && !isIdle(s)) continue;
      }
    }
    await attempt(s);
  }
  s.running = false;
}

function ensureRunning(s: DarkroomState): void {
  if (s.running || s.dl.settled) return;
  s.running = true;
  void run(s);
}

// 暗房页入口：前台优先，缓存命中直接给字节，否则立即下载并回报进度
export async function awaitDarkroomModel(onProgress?: ModelProgress): Promise<ModelResult> {
  const s = state();
  s.dl.foreground = true;
  s.dl.readyAt = 0;

  if (!s.dl.buffer) {
    const cached = await readCachedModel();
    if (cached) {
      settle(s, cached, true);
      return { buffer: cached, fromCache: true };
    }
  }

  if (s.dl.failed) reset(s);
  if (s.dl.settled && s.dl.buffer) return { buffer: s.dl.buffer, fromCache: s.dl.fromCache };

  return new Promise<ModelResult>((resolve, reject) => {
    s.waiters.push({ resolve, reject, onProgress });
    ensureRunning(s);
  });
}

// 站点级入口：默认空闲时静默预取，非空闲自动暂停；
// eager 用于用户已悬停/聚焦暗房入口或进入底栏的场景，跳过等待立即下载
export function prefetchDarkroomModel(options: { eager?: boolean } = {}): void {
  const s = state();
  if (s.dl.settled || s.dl.failed) return;
  if (options.eager) {
    s.dl.eager = true;
    s.dl.readyAt = 0;
  }
  void hasCachedModel().then((cached) => {
    // 已在磁盘上：不必占用内存，进暗房时由页面自己读
    if (cached) return;
    ensureRunning(s);
  });
}
