// 日记列表的无限加载：首屏只渲染一页，滚到底部附近时取下一页并追加。
// 无 JS 时那条链接就是普通的分页跳转（/diary/page/N/），内容始终可达。
// 分页回退页本身不启用自动追加，避免从第 3 页落地时又一路往后吞。

let observer: IntersectionObserver | null = null;
let controller: AbortController | null = null;
let loading = false;
let pending: Promise<void> | null = null;
const loaded = new Set<string>();

function sentinel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-ledger-more]');
}

function setStatus(text: string): void {
  const status = sentinel()?.querySelector<HTMLElement>('[data-ledger-status]');
  if (status) status.textContent = text;
}

function nextHref(): string | null {
  return sentinel()?.dataset.next ?? null;
}

/** 全站日记总篇数（分页回退页上没有这个属性，拿不到就返回 null） */
function total(): number | null {
  const raw = document.querySelector<HTMLElement>('[data-ledger-infinite]')?.dataset.ledgerTotal;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 列表里当前已经排出来多少条 */
function shownCount(): number {
  const list = document.querySelector('[data-ledger-infinite]');
  return list ? list.querySelectorAll(':scope > .ledger-entry').length : 0;
}

/** 加载中/加载后的进度：知道总数就带上总数，让人知道还剩多少 */
function setProgress(done: number): void {
  const all = total();
  setStatus(all ? `已加载 ${done} / ${all} 篇。` : `已加载 ${done} 篇。`);
}

function markEnd(): void {
  const more = sentinel();
  if (!more) return;
  more.removeAttribute('data-next');
  more.classList.remove('is-loading');
  more.classList.add('is-end');
  const link = more.querySelector('[data-ledger-next]');
  if (link) {
    const span = document.createElement('span');
    span.className = 'ledger-more-end';
    span.textContent = '所有日记都在这里了';
    link.replaceWith(span);
  }
  more.querySelector('.ledger-more-hint')?.remove();
  observer?.disconnect();
  observer = null;
}

/** 把下一页的 data-next / 剩余数接到当前哨兵上；返回是否已经到底 */
function applyRemoteMore(remote: Element | null): boolean {
  const more = sentinel();
  if (!more) return false;
  const next = remote?.getAttribute('data-next');
  if (!next) {
    markEnd();
    return true;
  }

  more.dataset.next = next;
  const link = more.querySelector<HTMLAnchorElement>('[data-ledger-next]');
  if (link) link.href = next;

  const hint = more.querySelector<HTMLElement>('.ledger-more-hint');
  const remoteHint = remote?.querySelector<HTMLElement>('.ledger-more-hint');
  if (hint) {
    if (remoteHint?.textContent) hint.textContent = remoteHint.textContent;
    else hint.remove();
  }
  return false;
}

async function runLoad(): Promise<void> {
  const more = sentinel();
  const url = nextHref();
  if (!more || !url) return;

  loading = true;
  more.classList.add('is-loading');
  more.classList.remove('is-error');
  setStatus('正在取下一页…');
  controller = new AbortController();

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/html' },
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const ledger = document.querySelector('[data-ledger]');
    const incoming = Array.from(doc.querySelectorAll('[data-ledger] > .ledger-entry'));
    if (!ledger || incoming.length === 0) {
      markEnd();
      setStatus('');
      return;
    }

    ledger.append(...incoming);
    loaded.add(url);

    // 到底了就只说一句总篇数；没到底才报这一批的进度
    const ended = applyRemoteMore(doc.querySelector('[data-ledger-more]'));
    if (ended) {
      const all = total();
      setStatus(all ? `共 ${all} 篇。` : '');
    } else {
      setProgress(shownCount());
    }

    document.dispatchEvent(
      new CustomEvent('moxo:ledger-updated', { detail: { added: incoming.length } }),
    );

    // 观察器对同一元素不会重复回调；重新 observe 会立即按当前状态再判一次，
    // 视口很高/条目很短时能自动续上下一页
    const fresh = sentinel();
    if (fresh && observer) {
      observer.unobserve(fresh);
      observer.observe(fresh);
    }
  } catch (error) {
    if ((error as Error).name !== 'AbortError') {
      setStatus('没取到下一页，点链接再试一次。');
      more.classList.add('is-error');
    }
  } finally {
    loading = false;
    controller = null;
    sentinel()?.classList.remove('is-loading');
  }
}

function load(): Promise<void> {
  if (pending) return pending;
  const more = sentinel();
  const url = nextHref();
  if (!more || !url || loaded.has(url)) return Promise.resolve();

  const task = runLoad().finally(() => {
    if (pending === task) pending = null;
  });
  pending = task;
  return task;
}

/** 按全局篇序取到第 index 篇（0 起），需要时逐页补载；返回对应行元素 */
export async function ledgerSeek(index: number): Promise<HTMLElement | null> {
  const ledger = document.querySelector<HTMLElement>('[data-ledger-infinite]');
  if (!ledger) return null;

  const collect = () =>
    Array.from(ledger.querySelectorAll<HTMLElement>(':scope > .ledger-entry'));
  let rows = collect();
  let guard = 0;

  while (ledger.isConnected && rows.length <= index && nextHref() && guard < 32) {
    const before = rows.length;
    await load();
    rows = collect();
    if (rows.length === before) break;
    guard += 1;
  }

  if (rows.length === 0) return null;
  return rows[Math.min(index, rows.length - 1)] ?? null;
}

function init(): void {
  observer?.disconnect();
  observer = null;
  controller?.abort();
  controller = null;
  pending = null;
  loading = false;
  loaded.clear();

  const more = sentinel();
  if (!more || !more.dataset.next || !document.querySelector('[data-ledger-infinite]')) return;

  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void load();
    },
    { rootMargin: '900px 0px' },
  );
  observer.observe(more);
}

document.addEventListener('click', (event) => {
  const link = event.target instanceof Element ? event.target.closest('[data-ledger-next]') : null;
  if (!link || !document.querySelector('[data-ledger-infinite]')) return;
  event.preventDefault();
  if (!loading) void load();
});

document.addEventListener('astro:page-load', init);
document.addEventListener('astro:before-swap', () => {
  observer?.disconnect();
  observer = null;
  controller?.abort();
  controller = null;
  pending = null;
  loading = false;
});
init();
