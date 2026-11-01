import { gsap } from 'gsap';

/**
 * 胶片走带控制器：一卷一个实例。
 *
 * 输入只写 raw（无界），target 由 raw 经指数阻尼压回胶卷两端，
 * current 以帧率无关的阻尼追 target；滚轮/拖拽/游标都走这条路，
 * 所以胶卷永远不会被游标或任何别的元素夹住。
 */

const ROOT = '.filmroll[data-film-roll]';
const WHEEL_IDLE_MS = 150;
const WHEEL_OVER_GAIN = 0.55;

interface RollController {
  section: HTMLElement;
  strip: HTMLElement;
  feedWheel(deltaY: number, deltaMode: number): void;
  /** 指针是否仍在胶片的片基范围内（齿孔上下缘以内） */
  isInsidePoint(x: number, y: number): boolean;
  destroy(): void;
}

let controllers: RollController[] = [];
let active: RollController | null = null;
let globalAbort: AbortController | null = null;
let reduceQuery: MediaQueryList | null = null;
let pointer = { x: 0, y: 0, known: false };

const reduced = () => reduceQuery?.matches ?? false;

function arm(controller: RollController) {
  if (active === controller) return;
  disarmFilmRolls();
  active = controller;
  controller.section.classList.add('is-armed');
}

/** 灯箱打开、点到处或指针移远时调用：滚轮立刻归还页面 */
export function disarmFilmRolls() {
  if (!active) return;
  active.section.classList.remove('is-armed');
  active = null;
}

function bindGlobals() {
  if (globalAbort) return;
  const abort = (globalAbort = new AbortController());
  const { signal } = abort;

  /* 捕获阶段先于站内滚轮缓动：接管时把 defaultPrevented 立起来，页面缓动自然让路 */
  window.addEventListener(
    'wheel',
    (event) => {
      if (!active) return;
      pointer = { x: event.clientX, y: event.clientY, known: true };
      if (event.ctrlKey || event.metaKey || event.shiftKey) {
        disarmFilmRolls();
        return;
      }
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (!active.isInsidePoint(event.clientX, event.clientY)) {
        disarmFilmRolls();
        return;
      }
      event.preventDefault();
      active.feedWheel(event.deltaY, event.deltaMode);
    },
    { passive: false, capture: true, signal },
  );

  window.addEventListener(
    'pointermove',
    (event) => {
      pointer = { x: event.clientX, y: event.clientY, known: true };
      if (!active) return;
      const hovered = event.target instanceof Element ? event.target.closest('.filmroll') : null;
      if (hovered && hovered !== active.section) {
        disarmFilmRolls();
        return;
      }
      if (!active.isInsidePoint(event.clientX, event.clientY)) disarmFilmRolls();
    },
    { passive: true, signal },
  );

  window.addEventListener(
    'pointerdown',
    (event) => {
      if (!active) return;
      const target = event.target;
      if (target instanceof Element && active.section.contains(target)) return;
      disarmFilmRolls();
    },
    { capture: true, signal },
  );

  window.addEventListener(
    'scroll',
    () => {
      if (active && pointer.known && !active.isInsidePoint(pointer.x, pointer.y)) disarmFilmRolls();
    },
    { passive: true, signal },
  );

  window.addEventListener('blur', disarmFilmRolls, { signal });
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) disarmFilmRolls();
    },
    { signal },
  );
}

function createRoll(section: HTMLElement, strip: HTMLElement): RollController | null {
  const band = strip.querySelector<HTMLElement>('.film-band');
  if (!band) return null;

  const filmstrip = section.querySelector<HTMLElement>('.filmstrip') ?? strip;
  const knob = section.querySelector<HTMLElement>('.scrub-knob');
  const track = section.querySelector<HTMLElement>('.scrub-track');
  const canister = section.querySelector<HTMLElement>('.fs-canister');
  const frames = [...strip.querySelectorAll<HTMLElement>('.fs-frame')];
  const firstPic = strip.querySelector<HTMLElement>('.fs-pic');
  const mirrored = filmstrip.classList.contains('side-right');
  const setBandX = gsap.quickSetter(band, 'x', 'px') as (value: number) => void;
  const abort = new AbortController();
  const { signal } = abort;

  let max = 0;
  let bandW = 0;
  let viewportW = 0;
  let trackW = 0;
  let knobW = 0;
  let centers: number[] = [];

  /* raw 是手感位置，target 是压过阻尼的位置，current 是屏幕上真正的位置 */
  let raw = 0;
  let target = 0;
  let current = 0;
  let running = false;
  let rawTween: gsap.core.Tween | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  let pointerId: number | null = null;
  let pointerDown = false;
  let dragging = false;
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let lastT = 0;
  let velocity = 0;
  let suppressClickUntil = 0;

  let scrubbing = false;
  let lastTension = -1;
  let capsTimer: ReturnType<typeof setTimeout> | null = null;

  const overLimit = () => Math.max(56, Math.min(180, viewportW * 0.2));

  /** 超出卷头/卷尾的位移走渐近阻尼：越拉越沉，但永远还能再拉一点 */
  const resistance = (distance: number) => {
    const limit = overLimit();
    return limit * (1 - Math.exp(-distance / limit));
  };

  const damp = (value: number) => {
    if (value < 0) return -resistance(-value);
    if (value > max) return max + resistance(value - max);
    return value;
  };

  const clamp = (value: number, min: number, maxValue: number) => Math.max(min, Math.min(maxValue, value));

  /* 字幕只服从一个状态机：按下或移动立刻收，收起后一直保持；
     只有指针/游标都松开、滚轮待定计时结束、回弹补间归零、带子真正停稳才展开。
     回弹过零点时瞬时速度会短暂归零，所以不能用速度判断"停稳" */
  const capsAtRest = () => !pointerDown && !scrubbing && rawTween === null && idleTimer === null;

  const hideCaps = (duration = 120) => {
    if (capsTimer !== null) {
      clearTimeout(capsTimer);
      capsTimer = null;
    }
    filmstrip.style.setProperty('--cap-hide-dur', `${Math.round(clamp(duration, 80, 200))}ms`);
    filmstrip.classList.add('is-caps-hidden');
  };

  const showCaps = () => {
    if (!capsAtRest()) return;
    if (capsTimer !== null) {
      clearTimeout(capsTimer);
      capsTimer = null;
    }
    filmstrip.classList.remove('is-caps-hidden');
  };

  /** 停稳后略等一拍再展开：单击/轻点不至于让字幕闪一下。
      若回弹还在跑，交给 render 停稳那一刻直接展开 */
  const queueShowCaps = () => {
    if (!capsAtRest() || running) return;
    if (capsTimer !== null) clearTimeout(capsTimer);
    capsTimer = setTimeout(() => {
      capsTimer = null;
      showCaps();
    }, 160);
  };

  const paint = () => {
    setBandX(-current);

    if (!knob) return;

    const over = current < -0.01 ? -current : current > max + 0.01 ? current - max : 0;
    const tension = Math.min(1, over / Math.max(1, overLimit()));

    let progress = max > 0 ? current / max : 0;
    if (mirrored) progress = 1 - progress;
    const span = Math.max(0, trackW - knobW);
    const knobX = clamp(progress * span, 0, span);
    const squash = 1 - 0.5 * tension;

    let origin = '50% 50%';
    if (tension > 0 && max > 0) {
      if (knobX <= 0.5) origin = 'left center';
      else if (knobX >= span - 0.5) origin = 'right center';
    }

    knob.style.transformOrigin = origin;
    knob.style.transform = `translate3d(${knobX}px, 0, 0) scaleX(${squash})`;

    const rounded = Math.round(tension * 100) / 100;
    if (rounded !== lastTension) {
      lastTension = rounded;
      section.style.setProperty('--film-tension', String(rounded));
      track?.classList.toggle('is-tension', rounded > 0);
    }
  };

  const render = () => {
    const dt = Math.min(gsap.ticker.deltaRatio(60), 4) / 60;
    const k = reduced() ? 1000 : scrubbing ? 32 : dragging ? 42 : 13;
    current += (target - current) * (1 - Math.exp(-k * dt));
    if (Math.abs(target - current) < 0.05) {
      current = target;
      paint();
      running = false;
      gsap.ticker.remove(render);
      showCaps();
      return;
    }
    paint();
  };

  const wake = () => {
    if (running) return;
    running = true;
    gsap.ticker.add(render);
  };

  const stopInput = () => {
    rawTween?.kill();
    rawTween = null;
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const tweenRaw = (to: number, duration: number, ease: string) => {
    stopInput();
    if (reduced()) {
      raw = to;
      target = damp(raw);
      wake();
      return;
    }
    const proxy = { value: raw };
    rawTween = gsap.to(proxy, {
      value: to,
      duration,
      ease,
      overwrite: true,
      onUpdate: () => {
        raw = proxy.value;
        target = damp(raw);
        wake();
      },
      onComplete: () => {
        raw = to;
        target = damp(raw);
        rawTween = null;
        wake();
      },
    });
    wake();
  };

  const applyRaw = () => {
    target = damp(raw);
    wake();
  };

  const nearestCenter = (value: number) => {
    let best = centers.length > 0 ? centers[0] : clamp(value, 0, max);
    for (const center of centers) {
      if (Math.abs(center - value) < Math.abs(best - value)) best = center;
    }
    return clamp(best, 0, max);
  };

  const measure = () => {
    const previousMax = max;
    viewportW = strip.clientWidth;

    /* 窄屏判定：留出卷壳后放不下一整格画幅 + 下一格边缘，就把卷壳推出屏幕 */
    if (canister && firstPic) {
      const frameW = firstPic.offsetWidth;
      const canW = canister.offsetWidth;
      const peek = Math.min(52, Math.max(20, frameW * 0.08));
      const tucked = viewportW - canW - 18 < frameW + peek;
      section.classList.toggle('is-canister-tucked', tucked);
      filmstrip.classList.toggle('is-canister-tucked', tucked);
    }

    bandW = band.offsetWidth;
    max = Math.max(0, bandW - viewportW);
    trackW = track?.clientWidth ?? 0;

    if (knob && track) {
      const visible = bandW > 0 ? Math.min(1, viewportW / bandW) : 1;
      knobW = Math.max(24, Math.min(trackW, visible * trackW));
      knob.style.width = `${knobW}px`;
      knobW = knob.offsetWidth || knobW;
    }

    centers = frames.map((frame) =>
      clamp(frame.offsetLeft + frame.offsetWidth / 2 - viewportW / 2, 0, max),
    );

    /* 视口变宽变窄时保住卷内相对位置，别让正在看的格子跳走 */
    if (previousMax > 0 && max !== previousMax) raw = (current / previousMax) * max;
    const limit = overLimit() * 3;
    raw = clamp(raw, -limit, max + limit);
    target = damp(raw);
    current = target;
    showCaps();
    paint();
  };

  const ro = new ResizeObserver(measure);
  ro.observe(strip);
  if (track) ro.observe(track);
  measure();

  /* ---- 指针拖拽：1:1 跟手，越界只压不夹；松手在界外就弹回，界内就近落格 ---- */
  strip.addEventListener(
    'pointerdown',
    (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      if (!event.isPrimary) return;
      pointerId = event.pointerId;
      pointerDown = true;
      dragging = false;
      downX = lastX = event.clientX;
      downY = event.clientY;
      lastT = event.timeStamp;
      velocity = 0;
      stopInput();
      hideCaps(100);
      target = damp(raw);
      wake();
      /* 鼠标点一下任何胶片元素，滚轮就归这一卷；触屏没有滚轮，不抢 */
      if (event.pointerType === 'mouse') arm(controller);
    },
    { signal },
  );

  strip.addEventListener(
    'pointermove',
    (event) => {
      if (!pointerDown || event.pointerId !== pointerId) return;

      const totalX = event.clientX - downX;
      if (!dragging) {
        if (Math.abs(totalX) < 6) return;
        /* 触屏竖扫交给页面；横指才接过底片 */
        if (event.pointerType !== 'mouse' && Math.abs(totalX) < Math.abs(event.clientY - downY)) return;
        dragging = true;
        strip.classList.add('is-drag');
        section.classList.add('is-drag');
        if (!strip.hasPointerCapture(event.pointerId)) {
          try {
            strip.setPointerCapture(event.pointerId);
          } catch {
            /* 合成事件没有活动指针，忽略 */
          }
        }
      }

      const dx = event.clientX - lastX;
      lastX = event.clientX;
      const dt = Math.max(1, event.timeStamp - lastT);
      lastT = event.timeStamp;

      /* 镜像卷的带在反转坐标系里：指针位移与带走同号 */
      const step = mirrored ? dx : -dx;
      raw += step;
      velocity = velocity * 0.78 + (step / dt) * 0.22;
      applyRaw();
    },
    { signal },
  );

  const endDrag = (event: PointerEvent) => {
    if (!pointerDown || event.pointerId !== pointerId) return;
    pointerDown = false;
    pointerId = null;
    const wasDragging = dragging;
    dragging = false;
    strip.classList.remove('is-drag');
    section.classList.remove('is-drag');
    if (strip.hasPointerCapture(event.pointerId)) {
      try {
        strip.releasePointerCapture(event.pointerId);
      } catch {
        /* 已经释放 */
      }
    }
    if (!wasDragging) {
      queueShowCaps();
      return;
    }

    /* 拖完紧跟的 click 不能当成"点开照片" */
    suppressClickUntil = performance.now() + 260;

    if (max <= 0) {
      tweenRaw(0, 1, 'elastic.out(1, 0.38)');
      return;
    }
    if (raw < 0) {
      tweenRaw(0, 1.1, 'elastic.out(1, 0.38)');
      return;
    }
    if (raw > max) {
      tweenRaw(max, 1.1, 'elastic.out(1, 0.38)');
      return;
    }
    const projected = raw + clamp(velocity, -3, 3) * 160;
    tweenRaw(nearestCenter(projected), 0.62, 'power3.out');
  };

  strip.addEventListener('pointerup', endDrag, { signal });
  strip.addEventListener('pointercancel', endDrag, { signal });

  strip.addEventListener(
    'click',
    (event) => {
      if (performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    { capture: true, signal },
  );

  /* 图片/文字一律不许被原生拖出去，拖动只移动胶片 */
  strip.addEventListener('dragstart', (event) => event.preventDefault(), { signal });

  /* ---- 下方游标：只做"跳到哪儿"，从不反向夹住胶卷 ---- */
  if (track && knob) {
    let grabbing = false;
    let grabOffset = 0;

    const span = () => Math.max(1, trackW - knobW);
    const knobLeft = () => {
      let progress = max > 0 ? current / max : 0;
      if (mirrored) progress = 1 - progress;
      return clamp(progress * (trackW - knobW), 0, trackW - knobW);
    };

    const seek = (clientX: number) => {
      if (max <= 0) return;
      const box = track.getBoundingClientRect();
      const width = span();
      const left = clientX - box.left - grabOffset;
      const progress = clamp((mirrored ? width - left : left) / width, 0, 1);
      raw = progress * max;
      target = damp(raw);
      wake();
    };

    track.addEventListener(
      'pointerdown',
      (event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (!event.isPrimary || max <= 0) return;
        event.preventDefault();
        stopInput();
        hideCaps(100);
        grabbing = true;
        scrubbing = true;
        if (event.pointerType === 'mouse') arm(controller);

        const box = track.getBoundingClientRect();
        const px = event.clientX - box.left;
        const left = knobLeft();
        grabOffset = px >= left && px <= left + knobW ? px - left : knobW / 2;
        seek(event.clientX);
        try {
          track.setPointerCapture(event.pointerId);
        } catch {
          /* 合成事件没有活动指针，忽略 */
        }
        track.classList.add('is-live');
      },
      { signal },
    );

    track.addEventListener(
      'pointermove',
      (event) => {
        if (grabbing) seek(event.clientX);
      },
      { signal },
    );

    const endSeek = (event: PointerEvent) => {
      if (!grabbing) return;
      grabbing = false;
      scrubbing = false;
      track.classList.remove('is-live');
      if (track.hasPointerCapture(event.pointerId)) {
        try {
          track.releasePointerCapture(event.pointerId);
        } catch {
          /* 已经释放 */
        }
      }
      queueShowCaps();
    };

    track.addEventListener('pointerup', endSeek, { signal });
    track.addEventListener('pointercancel', endSeek, { signal });
  }

  /* ---- 滚轮：只有被点活、且指针仍在卷附近的那一卷吃滚轮 ---- */
  const feedWheel = (deltaY: number, deltaMode: number) => {
    stopInput();
    const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? viewportW : 1;
    /* 第一次滚进本卷就收字幕：滚得越猛收得越急；字幕已收起时不重设时长 */
    if (!filmstrip.classList.contains('is-caps-hidden')) {
      const kick = Math.min(1, (Math.abs(deltaY) * unit) / 120);
      hideCaps(155 - 65 * kick);
    }
    const overscrolled = raw < 0 || raw > max;
    raw += deltaY * unit * (overscrolled ? WHEEL_OVER_GAIN : 1);
    const limit = overLimit() * 3;
    raw = clamp(raw, -limit, max + limit);
    target = damp(raw);
    wake();

    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (raw < -0.5) tweenRaw(0, 1.1, 'elastic.out(1, 0.38)');
      else if (raw > max + 0.5) tweenRaw(max, 1.1, 'elastic.out(1, 0.38)');
      else showCaps();
    }, WHEEL_IDLE_MS);
  };

  /* ---- 键盘：方向键按视觉左右换格，焦点跟到相邻画幅上 ----
     焦点移动会触发下面的 focusin，把这一格推回视口中央——
     焦点的位置和胶片的停位永远是同一格 */
  const activeFrameIndex = () => {
    const el = document.activeElement;
    if (!(el instanceof Element) || !strip.contains(el)) return -1;
    const frame = el.closest('.fs-frame');
    return frame instanceof HTMLElement ? frames.indexOf(frame) : -1;
  };

  const nearestFrameIndex = () => {
    let best = 0;
    for (let i = 1; i < centers.length; i++) {
      if (Math.abs(centers[i] - target) < Math.abs(centers[best] - target)) best = i;
    }
    return best;
  };

  strip.addEventListener(
    'keydown',
    (event) => {
      if (max <= 0) return;
      const right = event.key === 'ArrowRight' || event.key === 'ArrowDown';
      const left = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
      const home = event.key === 'Home';
      const end = event.key === 'End';
      if (!right && !left && !home && !end) return;
      event.preventDefault();
      hideCaps(110);

      const lastIndex = Math.max(0, frames.length - 1);
      let next = 0;
      let fallback = 0;
      if (home) {
        next = 0;
      } else if (end) {
        next = lastIndex;
        fallback = max;
      } else {
        const from = activeFrameIndex();
        const step = right ? (mirrored ? -1 : 1) : mirrored ? 1 : -1;
        next = clamp((from >= 0 ? from : nearestFrameIndex()) + step, 0, lastIndex);
        fallback = centers[next] ?? (step > 0 ? max : 0);
      }

      const pic = frames[next]?.querySelector<HTMLElement>('.fs-pic[data-full]');
      if (pic) {
        pic.focus({ preventScroll: true });
        const center = centers[next];
        if (center !== undefined && Math.abs(center - current) > 0.5) tweenRaw(center, 0.45, 'power3.out');
        return;
      }
      tweenRaw(fallback, 0.45, 'power3.out');
    },
    { signal },
  );

  /* Tab/方向键把画幅带进视口时，把它推回中央（overflow:clip 不会自己滚） */
  strip.addEventListener(
    'focusin',
    (event) => {
      const frame = event.target instanceof Element ? event.target.closest('.fs-frame') : null;
      if (!(frame instanceof HTMLElement)) return;
      const index = frames.indexOf(frame);
      if (index < 0) return;
      hideCaps(110);
      const center = centers[index];
      if (center !== undefined && Math.abs(center - current) > 12) tweenRaw(center, 0.42, 'power3.out');
    },
    { signal },
  );

  const controller: RollController = {
    section,
    strip,
    feedWheel,
    isInsidePoint(x, y) {
      const box = filmstrip.getBoundingClientRect();
      if (x < box.left - 2 || x > box.right + 2) return false;
      if (!firstPic) return y >= box.top && y <= box.bottom;
      /* 35mm 片基比 24mm 画幅上下各多 5.5mm：齿孔外缘就是滚轮接管的边界 */
      const picture = firstPic.getBoundingClientRect();
      const margin = (picture.height * (35 / 24) - picture.height) / 2;
      return y >= picture.top - margin - 2 && y <= picture.bottom + margin + 2;
    },
    destroy() {
      abort.abort();
      rawTween?.kill();
      rawTween = null;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = null;
      if (capsTimer !== null) clearTimeout(capsTimer);
      capsTimer = null;
      if (active?.section === section) disarmFilmRolls();
      gsap.ticker.remove(render);
      ro.disconnect();
    },
  };

  return controller;
}

export function initFilmRolls() {
  destroyFilmRolls();
  reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  pointer = { x: 0, y: 0, known: false };

  const sections = [...document.querySelectorAll<HTMLElement>(ROOT)];
  controllers = sections
    .map((section) => {
      const strip = section.querySelector<HTMLElement>('.film-viewport');
      return strip ? createRoll(section, strip) : null;
    })
    .filter((controller): controller is RollController => controller !== null);

  bindGlobals();
}

export function destroyFilmRolls() {
  disarmFilmRolls();
  for (const controller of controllers) controller.destroy();
  controllers = [];
  globalAbort?.abort();
  globalAbort = null;
}

initFilmRolls();
document.addEventListener('astro:page-load', initFilmRolls);
document.addEventListener('astro:before-swap', destroyFilmRolls);
