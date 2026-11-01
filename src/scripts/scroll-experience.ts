/**
 * 滚动体验：精细指针下的短程滚轮缓动 + 右侧页边索引。
 * 触控板细碎增量、键盘、触屏、可滚动子元素、对话框和暗房页保持原生滚动。
 */

import { gsap } from 'gsap';
import { ledgerSeek } from './diary-ledger';

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const WHEEL_FLOOR = 28;
const EASE_MS = 88;
const ENGAGE_MS = 1100;

const maxScroll = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
const prefersReduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const finePointer = () =>
  window.matchMedia('(min-width: 960px) and (hover: hover) and (pointer: fine)').matches;
const isBare = () => document.body.classList.contains('is-bare');
const railDisabled = () => document.querySelector('[data-rail="off"]') !== null;

let wheelTarget = 0;
let wheelCurrent = 0;
let wheelFrame = 0;
let lastFrameTime = 0;
let lastWritten = 0;

function writeScroll(top: number): void {
  lastWritten = top;
  window.scrollTo({
    top,
    left: window.scrollX,
    behavior: 'instant' as ScrollBehavior,
  });
}

function stopWheel(): void {
  if (wheelFrame) cancelAnimationFrame(wheelFrame);
  wheelFrame = 0;
}

function settleWheel(): void {
  stopWheel();
  wheelTarget = wheelCurrent = lastWritten = window.scrollY;
}

function wheelStep(now: number): void {
  const dt = Math.min(64, now - lastFrameTime || 16);
  lastFrameTime = now;
  const ease = 1 - Math.exp(-dt / EASE_MS);
  wheelCurrent += (wheelTarget - wheelCurrent) * ease;

  if (Math.abs(wheelTarget - wheelCurrent) < 0.35) {
    wheelCurrent = wheelTarget;
    wheelFrame = 0;
  } else {
    wheelFrame = requestAnimationFrame(wheelStep);
  }

  writeScroll(wheelCurrent);
}

function isScrollable(node: Element): boolean {
  const { overflowY } = getComputedStyle(node);
  return /(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight - node.clientHeight > 1;
}

function keepsNativeScroll(event: WheelEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.shiftKey) return true;
  if (document.querySelector('dialog[open]')) return true;
  for (const node of event.composedPath()) {
    if (node === document.body || node === document.documentElement) break;
    if (!(node instanceof Element)) continue;
    // 家具层（书架 / 货架 / 胶卷柜）在窄窗里自己横滑，别抢它的滚轮
    if (node.hasAttribute('data-scroll-native')) return true;
    if (isScrollable(node)) return true;
  }
  return false;
}

function onWheel(event: WheelEvent): void {
  rail?.cancelSeek();
  if (event.defaultPrevented || event.deltaY === 0) return;
  if (!finePointer() || isBare() || prefersReduced()) return;
  if (keepsNativeScroll(event)) return;
  // 触控板会以很小的增量连续发事件，保留它自己的惯性手感
  if (Math.abs(event.deltaY) < WHEEL_FLOOR) return;

  let delta = event.deltaY;
  if (event.deltaMode === 1) delta *= 16;
  else if (event.deltaMode === 2) delta *= window.innerHeight;

  if (!wheelFrame) {
    wheelTarget = wheelCurrent = window.scrollY;
    lastFrameTime = 0;
  }

  const next = clamp(wheelTarget + delta, 0, maxScroll());
  if (next === wheelTarget) {
    if (wheelFrame) event.preventDefault();
    return;
  }

  wheelTarget = next;
  event.preventDefault();

  if (!wheelFrame) wheelFrame = requestAnimationFrame(wheelStep);
}

function jumpTo(top: number): void {
  const next = clamp(top, 0, maxScroll());

  if (prefersReduced()) {
    stopWheel();
    wheelTarget = wheelCurrent = lastWritten = next;
    writeScroll(next);
    return;
  }

  stopWheel();
  lastWritten = window.scrollY;
  window.scrollTo({ top: next, left: window.scrollX, behavior: 'smooth' });
}

let glideTween: gsap.core.Tween | null = null;

const seizeWheel = (event: WheelEvent) => {
  if (!event.ctrlKey && !event.metaKey) event.preventDefault();
};

function stopGlide(): void {
  glideTween?.kill();
  glideTween = null;
  window.removeEventListener('wheel', seizeWheel, { capture: true });
}

export function glideTo(targetY: number, done?: () => void): void {
  stopGlide();
  settleWheel();
  const next = clamp(targetY, 0, maxScroll());
  const dy = next - window.scrollY;
  if (prefersReduced() || Math.abs(dy) < 2) {
    writeScroll(next);
    done?.();
    return;
  }

  // defaultPrevented 让站内滚轮缓动让路，避免落位后被它的残余帧拖走。
  window.addEventListener('wheel', seizeWheel, { capture: true, passive: false });
  // instant 写入代理坐标，避免 CSS smooth 再次平滑 GSAP 的逐帧位置。
  const proxy = { y: window.scrollY };
  glideTween = gsap.to(proxy, {
    y: next,
    duration: Math.max(0.38, Math.min(0.88, Math.abs(dy) * 0.0004)),
    ease: 'power2.inOut',
    onUpdate: () => writeScroll(proxy.y),
    onComplete: () => {
      glideTween = null;
      window.removeEventListener('wheel', seizeWheel, { capture: true });
      done?.();
    },
  });
}

function cleanText(value: string): string {
  return value
    .replace(/∞/g, '')
    .replace(/\s+/g, ' ')
    .replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
    .trim();
}

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('zh', { granularity: 'word' })
    : null;

function shorten(value: string, max = 10): string {
  const text = cleanText(value);
  if (text.length <= max) return text;

  const limit = max - 1;
  let out = '';
  if (segmenter) {
    for (const { segment } of segmenter.segment(text)) {
      if (out.length + segment.length > limit) break;
      out += segment;
    }
  }
  if (!out.trim()) out = Array.from(text).slice(0, limit).join('');
  return `${out.trimEnd()}…`;
}

class ScrollRail {
  private readonly root: HTMLElement;
  private readonly track: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly percentEl: HTMLElement;
  private readonly tickLayer: HTMLElement;
  private readonly pageTitle: string;
  private readonly headings: HTMLElement[];
  private readonly dates: HTMLElement[];
  private readonly dateMode: boolean;
  private readonly diaryLedger: HTMLElement | null;
  private readonly diaryTotal: number;
  private entries: HTMLElement[] = [];
  private rows: { top: number; height: number }[] = [];
  private previewRatio: number | null = null;
  private seekToken = 0;
  private sections: { top: number; label: string; full: string }[] = [];
  private marks: { top: number; tick: HTMLElement }[] = [];
  private max = 0;
  private progress = -1;
  private activeMark = -2;
  private activeLabel = '';
  private valueText = '';
  private frame = 0;
  private idleTimer = 0;
  private dragging = false;
  private readonly observer: ResizeObserver;

  constructor() {
    const root = document.createElement('div');
    root.className = 'scroll-rail';
    root.innerHTML = `
      <span class="scroll-rail-title" aria-hidden="true"></span>
      <div class="scroll-rail-track" role="scrollbar" aria-controls="main" aria-orientation="vertical"
        aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="页面阅读位置" tabindex="0">
        <span class="scroll-rail-line" aria-hidden="true"></span>
        <span class="scroll-rail-fill" aria-hidden="true"></span>
        <span class="scroll-rail-tick-layer" aria-hidden="true"></span>
        <span class="scroll-rail-marker" aria-hidden="true"></span>
      </div>
      <span class="scroll-rail-pct" aria-hidden="true"><span data-pct>0</span><span class="scroll-rail-pct-sign">%</span></span>
    `;

    this.root = root;
    this.track = root.querySelector('.scroll-rail-track') as HTMLElement;
    this.titleEl = root.querySelector('.scroll-rail-title') as HTMLElement;
    this.percentEl = root.querySelector('[data-pct]') as HTMLElement;
    this.tickLayer = root.querySelector('.scroll-rail-tick-layer') as HTMLElement;
    this.headings = Array.from(document.querySelectorAll<HTMLElement>('main h2')).filter((heading) => {
      if (!heading.textContent?.trim()) return false;
      if (heading.closest('.comments, .empty-state')) return false;
      return heading.getClientRects().length > 0;
    });
    this.dates = Array.from(document.querySelectorAll<HTMLElement>('[data-rail-date]')).filter(
      (date) => date.getClientRects().length > 0,
    );
    this.dateMode = this.dates.length > 0;
    this.diaryLedger = document.querySelector<HTMLElement>(
      '[data-ledger-infinite][data-ledger-total]',
    );
    this.diaryTotal = this.diaryLedger
      ? Math.max(0, Number(this.diaryLedger.dataset.ledgerTotal) || 0)
      : 0;
    this.entries = this.collectEntries();
    this.pageTitle =
      shorten(document.querySelector<HTMLElement>('main h1')?.textContent ?? document.title.split(' · ')[0]) || '页首';

    this.root.classList.toggle('is-date-mode', this.dateMode);
    this.track.setAttribute('aria-label', this.dateMode ? '日记日期位置' : '页面阅读位置');
    this.titleEl.textContent = this.pageTitle;
    document.body.append(root);

    this.observer = new ResizeObserver(() => this.measure());
    this.observer.observe(document.body);
    window.addEventListener('resize', this.onResize, { passive: true });
    window.addEventListener('scroll', this.onScroll, { passive: true });

    this.bindPointer();
    this.bindKeyboard();
    this.measure();

    this.root.classList.add('is-engaged');
    this.idleTimer = window.setTimeout(() => this.root.classList.remove('is-engaged'), 1400);
    document.fonts?.ready.then(() => this.measure()).catch(() => {});
  }

  private collectEntries(): HTMLElement[] {
    if (!this.diaryLedger) return [];
    return Array.from(
      this.diaryLedger.querySelectorAll<HTMLElement>(':scope > .ledger-entry'),
    );
  }

  /** 无限加载追加条目后重新收集日期并量一遍；没建 rail 时无需处理 */
  refreshTargets(): void {
    this.dates = Array.from(document.querySelectorAll<HTMLElement>('[data-rail-date]')).filter(
      (date) => date.getClientRects().length > 0,
    );
    this.dateMode = this.dates.length > 0;
    this.root.classList.toggle('is-date-mode', this.dateMode);
    this.track.setAttribute('aria-label', this.dateMode ? '日记日期位置' : '页面阅读位置');
    this.measure();
  }

  private measure(): void {
    this.max = maxScroll();
    const scrollTop = window.scrollY;
    this.entries = this.collectEntries();
    this.rows = this.entries.map((el) => {
      const rect = el.getBoundingClientRect();
      return { top: rect.top + scrollTop, height: rect.height };
    });
    const fragment = document.createDocumentFragment();
    this.marks = [];

    if (this.dateMode) {
      const months = new Set<string>();
      this.sections = this.dates.map((date) => {
        const top = date.getBoundingClientRect().top + scrollTop;
        const label = cleanText(date.dataset.railDate ?? '');
        const full = cleanText(date.dataset.railFull ?? label);
        const month = label.slice(0, 7);

        if (top > 0 && top <= this.max && month && !months.has(month)) {
          months.add(month);
          const entry = date.closest('.ledger-entry');
          const index = entry ? this.entries.indexOf(entry as HTMLElement) : -1;
          const ratio =
            this.diaryTotal > 0 && index >= 0
              ? index / this.diaryTotal
              : this.max > 0
                ? top / this.max
                : 0;
          const tick = document.createElement('span');
          tick.className = 'scroll-rail-tick is-month';
          tick.style.setProperty('--r', String(clamp(ratio, 0, 1)));
          tick.title = month;
          fragment.append(tick);
          this.marks.push({ top, tick });
        }

        return { top, label, full };
      });
    } else {
      this.sections = this.headings.map((heading) => {
        const full = cleanText(heading.textContent ?? '');
        const top = heading.getBoundingClientRect().top + scrollTop;

        if (top > 0 && top <= this.max) {
          const tick = document.createElement('span');
          tick.className = 'scroll-rail-tick';
          tick.style.setProperty('--r', String(clamp(top / this.max, 0, 1)));
          fragment.append(tick);
          this.marks.push({ top, tick });
        }

        return { top, label: shorten(full), full };
      });
    }

    this.tickLayer.replaceChildren(fragment);

    this.activeMark = -2;
    this.progress = -1;
    this.valueText = '';
    this.root.classList.toggle('is-visible', this.max > 120 && !isBare());
    this.track.tabIndex = this.max > 120 && !isBare() ? 0 : -1;
    this.refresh();
  }

  private refresh(): void {
    this.frame = 0;
    if (isBare()) {
      this.root.classList.remove('is-visible');
      return;
    }

    if (this.previewRatio !== null) return;

    const progress =
      this.diaryTotal > 0 && this.rows.length > 0
        ? this.diaryProgress()
        : this.max > 0
          ? clamp(window.scrollY / this.max, 0, 1)
          : 0;
    this.root.style.setProperty('--sp', progress.toFixed(4));

    if (progress !== this.progress) {
      this.progress = progress;
      const pct = Math.round(progress * 100);
      this.percentEl.textContent = String(pct);
      this.track.setAttribute('aria-valuenow', String(pct));
    }

    const cursor = window.scrollY + window.innerHeight * 0.45;
    let label = this.pageTitle;
    let full = this.pageTitle;
    this.sections.forEach((section) => {
      if (section.top <= cursor) {
        label = section.label;
        full = section.full;
      }
    });

    if (label !== this.activeLabel) {
      this.activeLabel = label;
      this.titleEl.textContent = label;
      this.titleEl.title = full;
    }

    const pct = Math.round(progress * 100);
    const valueText = this.dateMode ? `${full} · ${pct}%` : `${pct}% · ${label}`;
    if (valueText !== this.valueText) {
      this.valueText = valueText;
      this.track.setAttribute('aria-valuetext', valueText);
    }

    let active = -1;
    this.marks.forEach((mark, index) => {
      if (mark.top <= cursor) active = index;
    });
    if (active !== this.activeMark) {
      this.marks[this.activeMark]?.tick.classList.remove('is-current');
      this.marks[active]?.tick.classList.add('is-current');
      this.activeMark = active;
    }
  }

  private diaryProgress(): number {
    const cursor = window.scrollY + window.innerHeight * 0.45;
    let index = -1;
    this.rows.forEach((row, i) => {
      if (row.top <= cursor) index = i;
    });
    if (index < 0) return 0;

    const row = this.rows[index];
    const within = row.height > 0 ? clamp((cursor - row.top) / row.height, 0, 1) : 0;
    return clamp((index + within) / this.diaryTotal, 0, 1);
  }

  private engage = (): void => {
    this.root.classList.add('is-engaged');
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.root.classList.remove('is-engaged'), ENGAGE_MS);
  };

  private schedule = (): void => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => this.refresh());
  };

  private onScroll = (): void => {
    this.engage();
    this.schedule();
  };

  private onResize = (): void => {
    settleWheel();
    this.measure();
  };

  private bindPointer(): void {
    this.track.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      this.dragging = true;
      this.track.classList.add('is-dragging');
      this.track.focus({ preventScroll: true });
      this.track.setPointerCapture(event.pointerId);
      event.preventDefault();
      this.trackPointer(event.clientY, false);
    });

    this.track.addEventListener('pointermove', (event) => {
      if (!this.dragging) return;
      event.preventDefault();
      this.trackPointer(event.clientY, false);
    });

    const endDrag = (event: PointerEvent, commit: boolean) => {
      if (!this.dragging) return;
      this.dragging = false;
      this.track.classList.remove('is-dragging');
      if (this.track.hasPointerCapture(event.pointerId)) {
        this.track.releasePointerCapture(event.pointerId);
      }
      if (this.diaryTotal > 0) this.trackPointer(event.clientY, commit);
    };

    this.track.addEventListener('pointerup', (event) => endDrag(event, true));
    this.track.addEventListener('pointercancel', (event) => endDrag(event, false));
  }

  private trackPointer(clientY: number, commit: boolean): void {
    const rect = this.track.getBoundingClientRect();
    if (rect.height === 0) return;
    const ratio = clamp((clientY - rect.top) / rect.height, 0, 1);

    // 日记无限列表：轨道按“篇”计量，先跟手预演，松手才真正取页落位
    if (this.diaryTotal > 0) {
      this.preview(ratio);
      if (commit) void this.seekToRatio(ratio);
      return;
    }

    this.max = maxScroll();
    const top = ratio * this.max;

    stopWheel();
    wheelTarget = wheelCurrent = lastWritten = top;
    writeScroll(top);
    this.engage();
    this.schedule();
  }

  private preview(ratio: number): void {
    this.previewRatio = ratio;
    this.root.style.setProperty('--sp', ratio.toFixed(4));
    const pct = Math.round(ratio * 100);
    this.percentEl.textContent = String(pct);
    this.track.setAttribute('aria-valuenow', String(pct));
  }

  private async seekToRatio(ratio: number): Promise<void> {
    const total = this.diaryTotal;
    if (total <= 0) return;

    const token = ++this.seekToken;
    const position = clamp(ratio * total, 0, total - 0.0001);
    const index = Math.floor(position);
    this.root.classList.add('is-seeking');

    const el = await ledgerSeek(index);
    if (token !== this.seekToken) return;

    this.root.classList.remove('is-seeking');
    this.previewRatio = null;

    if (!el || !el.isConnected) {
      this.measure();
      return;
    }

    const rect = el.getBoundingClientRect();
    const top = rect.top + window.scrollY + (position - index) * rect.height;

    stopWheel();
    wheelTarget = wheelCurrent = lastWritten = top;
    writeScroll(top);
    this.engage();
    this.measure();
  }

  cancelSeek(): void {
    if (this.previewRatio === null && !this.root.classList.contains('is-seeking')) return;
    this.seekToken += 1;
    this.previewRatio = null;
    this.root.classList.remove('is-seeking');
    this.schedule();
  }

  private bindKeyboard(): void {
    this.track.addEventListener('keydown', (event) => {
      const viewport = window.innerHeight;
      let top: number;

      switch (event.key) {
        case 'ArrowUp':
          top = window.scrollY - 56;
          break;
        case 'ArrowDown':
          top = window.scrollY + 56;
          break;
        case 'PageUp':
          top = window.scrollY - viewport * 0.85;
          break;
        case 'PageDown':
        case ' ':
          top = window.scrollY + viewport * 0.85;
          break;
        case 'Home':
          top = 0;
          break;
        case 'End':
          if (this.diaryTotal > 0) {
            event.preventDefault();
            this.engage();
            void this.seekToRatio(1);
            return;
          }
          top = maxScroll();
          break;
        default:
          return;
      }

      event.preventDefault();
      this.engage();
      jumpTo(top);
    });
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.idleTimer);
    this.observer.disconnect();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('scroll', this.onScroll);
    this.root.remove();
  }
}

let backToTopStop: (() => void) | null = null;

function initBackToTop(): void {
  backToTopStop?.();
  backToTopStop = null;
  if (!document.querySelector('[data-back-to-top]')) return;

  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'dm-top';
  button.className = 'dm-top';
  button.innerHTML = '<span class="dm-top-arrow" aria-hidden="true">↑</span><span>回到顶部</span>';
  gsap.set(button, { autoAlpha: 0, y: 12 });
  button.tabIndex = -1;
  document.body.append(button);

  let visible = false;
  const update = () => {
    const next = window.scrollY > 320;
    if (next === visible) return;
    visible = next;
    button.tabIndex = visible ? 0 : -1;
    gsap.to(button, {
      autoAlpha: visible ? 1 : 0,
      y: visible ? 0 : 10,
      duration: prefersReduced() ? 0 : visible ? 0.3 : 0.25,
      ease: visible ? 'power2.out' : 'power2.in',
      overwrite: true,
    });
  };
  button.addEventListener('click', () => glideTo(0));
  window.addEventListener('scroll', update, { passive: true });
  update();

  backToTopStop = () => {
    window.removeEventListener('scroll', update);
    gsap.killTweensOf(button);
    button.remove();
  };
}

let rail: ScrollRail | null = null;
let cancelRailBoot: (() => void) | null = null;

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, opts: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
};

function initRail(): void {
  rail?.destroy();
  rail = null;
  cancelRailBoot?.();
  cancelRailBoot = null;

  const enabled = finePointer() && !isBare() && !railDisabled();
  if (!enabled) return;

  let done = false;
  const create = () => {
    if (done) return;
    done = true;
    cancelRailBoot?.();
    cancelRailBoot = null;
    if (rail || !finePointer() || isBare() || railDisabled()) return;
    rail = new ScrollRail();
  };

  // 首帧先留给内容：日记列表有几百个日期，等空闲或用户真的开始滚动再量，
  // 不跟首屏布局/图片解码抢同一批帧
  const idle = window as IdleWindow;
  const idleId = idle.requestIdleCallback
    ? idle.requestIdleCallback(create, { timeout: 1800 })
    : window.setTimeout(create, 900);
  const onMove = () => create();
  window.addEventListener('scroll', onMove, { passive: true });
  window.addEventListener('pointermove', onMove, { passive: true });

  cancelRailBoot = () => {
    if (idle.requestIdleCallback) idle.cancelIdleCallback?.(idleId);
    else window.clearTimeout(idleId);
    window.removeEventListener('scroll', onMove);
    window.removeEventListener('pointermove', onMove);
  };
}

window.addEventListener('wheel', onWheel, { passive: false });

window.addEventListener(
  'pointerdown',
  (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('.scroll-rail')) return;
    settleWheel();
    rail?.cancelSeek();
  },
  { capture: true, passive: true },
);

window.addEventListener(
  'keydown',
  (event) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      settleWheel();
      rail?.cancelSeek();
    }
  },
  { capture: true },
);

window.addEventListener('resize', settleWheel, { passive: true });

document.addEventListener('visibilitychange', () => {
  if (document.hidden) settleWheel();
});

document.addEventListener('astro:before-swap', () => {
  stopGlide();
  settleWheel();
  backToTopStop?.();
  backToTopStop = null;
  cancelRailBoot?.();
  cancelRailBoot = null;
  rail?.destroy();
  rail = null;
});

document.addEventListener('moxo:ledger-updated', () => rail?.refreshTargets());

document.addEventListener('astro:page-load', initBackToTop);
document.addEventListener('astro:page-load', initRail);
window.matchMedia('(min-width: 960px) and (hover: hover) and (pointer: fine)').addEventListener('change', initRail);
