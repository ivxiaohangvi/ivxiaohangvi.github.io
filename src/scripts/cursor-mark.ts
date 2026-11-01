// 动态指针：蓝晒准星跟随指针，整枚的自转角写进 --cm-rot（手停就慢慢回正）；
// 输入区立字标、照片开镜环、走带与导轨收光圈、刻度轨张开双向箭头，
// 只有 iframe 与顶层灯箱仍交还原生光标（top layer 之下准星画不进来）。
// 落点底色逐帧采样：压上胶片、暗房、照片这类深色面时，准星自动翻成药膜白并垫暗描边。

type State = 'idle' | 'arrow' | 'hand' | 'text' | 'zoom' | 'grab' | 'resize' | 'native';

const HAND = [
  'a', 'button', 'summary', '[role="button"]', 'label[for]', 'select',
  'input[type="submit"]', 'input[type="checkbox"]', 'input[type="radio"]',
  '#theme-toggle', '.diary-typing-skip', '.lightbox-close', '.darkroom-controls button',
].join(',');

const TEXT = [
  'input:not([type="submit"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"])',
  'textarea', '[contenteditable="true"]',
].join(',');

// 照片按钮优先于走带容器：点上照片开灯箱，拖上照片仍归走带接管；
// 日记图（列表缩略图 / 内页配图）同走开镜环
const ZOOM = '.fs-pic[data-full], [data-lightbox]';
const GRAB = '.film-viewport, .scroll-rail-track';
const RESIZE = '.scrub-track, input[type="range"]';
const NATIVE = 'iframe';

// 准星跟得比尾迹紧：它要压住落点，只留一点点柔性
const RINGS: Array<[string, number]> = [
  ['.cursor-mark-reg', 0.62],
];

const root = document.documentElement;
const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
const calm = window.matchMedia('(prefers-reduced-motion: reduce)');

let wrap: HTMLElement | null = null;
let rings: Array<{ el: HTMLElement; k: number; x: number; y: number }> = [];
let exempt: Element | null = null;
let state: State = 'idle';
let raf = 0;
let bound = false;
let spin = 0;
let speed = 0;
let stamp = 0;
let lastSample = 0;
const target = { x: 0, y: 0 };

function setState(next: State) {
  if (state === next) return;
  state = next;
  if (wrap) wrap.dataset.state = next;
}

function setExempt(next: Element | null) {
  if (exempt === next) return;
  exempt?.classList.remove('cursor-mark-native');
  next?.classList.add('cursor-mark-native');
  exempt = next;
}

function resolveHit(node: EventTarget | null) {
  if (!(node instanceof Element)) return;
  const native = node.closest(NATIVE);
  if (native) {
    setExempt(native);
    setState('native');
    return;
  }
  setExempt(null);
  if (node.closest(TEXT)) setState('text');
  else if (node.closest(ZOOM)) setState('zoom');
  else if (node.closest(GRAB)) setState('grab');
  else if (node.closest(RESIZE)) setState('resize');
  else setState(node.closest(HAND) ? 'hand' : 'arrow');
}

// 落点底色采样：照片/视频/画布一律按暗处理；往上找第一层不透明底色算亮度，
// 半透明底则再看背景图（片基、暗房材质都是深色渐变），都没有才算亮底
function isDarkSurface(node: Element | null): boolean {
  while (node) {
    const tag = node.tagName;
    if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS') return true;
    const cs = getComputedStyle(node);
    const rgba = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(
      cs.backgroundColor,
    );
    if (rgba) {
      const alpha = rgba[4] === undefined ? 1 : parseFloat(rgba[4]);
      if (alpha > 0.6) {
        const lum = (0.2126 * +rgba[1] + 0.7152 * +rgba[2] + 0.0722 * +rgba[3]) / 255;
        return lum < 0.5;
      }
    }
    if (cs.backgroundImage !== 'none') return true;
    node = node.parentElement;
  }
  return false;
}

function sampleBackdrop() {
  if (!wrap || state === 'idle' || state === 'native') return;
  // 自节流：指针移动事件能一次来一串，逐次算底色不值得
  const now = performance.now();
  if (now - lastSample < 140) return;
  lastSample = now;
  const next = isDarkSurface(document.elementFromPoint(target.x, target.y)) ? 'dark' : 'light';
  if (wrap.dataset.backdrop !== next) wrap.dataset.backdrop = next;
}

function tick(now = performance.now()) {
  const dt = Math.min(64, now - (stamp || now)) / 1000;
  stamp = now;
  // 底色采样：覆盖指针不动、胶片在脚下自走与平滑滚动挪动落点的情况
  sampleBackdrop();
  // 环还没追上目标的距离 ≈ 手速：拿它换算自转，比另测 pointermove 的时间差稳
  const gap = rings[0] ? Math.hypot(target.x - rings[0].x, target.y - rings[0].y) : 0;
  speed += (Math.min(1600, gap * 24) - speed) * 0.1;
  if (speed > 34) {
    spin += (9 + speed * 0.08) * dt;
  } else {
    // 手停：慢慢回到最近的直角，准星恢复成正的十字
    const snap = Math.round(spin / 90) * 90;
    spin += (snap - spin) * Math.min(1, dt * 1.8);
  }
  if (wrap) wrap.style.setProperty('--cm-rot', `${spin.toFixed(1)}deg`);

  for (const ring of rings) {
    ring.x += (target.x - ring.x) * ring.k;
    ring.y += (target.y - ring.y) * ring.k;
    // 先按自身尺寸回退半格再平移，准星中心（十字交点）就压在指针上；
    // 状态缩放交给 CSS 作用在环身内部，不碰这里的位移
    ring.el.style.transform = `translate3d(${ring.x.toFixed(2)}px, ${ring.y.toFixed(2)}px, 0) translate(-50%, -50%)`;
  }
  raf = requestAnimationFrame(tick);
}

function onMove(e: PointerEvent) {
  if (e.pointerType !== 'mouse') return;
  if (state === 'idle') {
    // 首次出现直接落在指针上，不让它从上一个位置飘过来
    for (const ring of rings) {
      ring.x = target.x = e.clientX;
      ring.y = target.y = e.clientY;
    }
    setState('arrow');
  }
  target.x = e.clientX;
  target.y = e.clientY;
  // 落点变了就顺势采样：pointerover 先于 pointermove 到，状态切换那一下读的还是旧坐标
  sampleBackdrop();
}

function apply() {
  const on = fine.matches && !calm.matches && rings.length > 0;
  root.classList.toggle('has-cursor-mark', on);
  if (!on) {
    cancelAnimationFrame(raf);
    raf = 0;
    setExempt(null);
    setState('idle');
    return;
  }
  if (!raf) raf = requestAnimationFrame(tick);
}

function init() {
  wrap = document.querySelector<HTMLElement>('.cursor-mark');
  if (wrap && !wrap.dataset.backdrop) wrap.dataset.backdrop = 'light';
  rings = wrap
    ? RINGS.flatMap(([sel, k]) => {
        const el = wrap?.querySelector<HTMLElement>(sel);
        return el ? [{ el, k, x: 0, y: 0 }] : [];
      })
    : [];
  exempt = null;
  setState('idle');
  apply();
}

if (!bound) {
  bound = true;
  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerover', (e) => resolveHit(e.target), true);
  document.addEventListener('pointerdown', () => wrap?.setAttribute('data-press', '1'), true);
  document.addEventListener('pointerup', () => wrap?.removeAttribute('data-press'), true);
  document.addEventListener('mouseleave', () => setState('idle'));
  window.addEventListener('blur', () => setState('idle'));
  fine.addEventListener('change', apply);
  calm.addEventListener('change', apply);
}

init();
document.addEventListener('astro:page-load', init);
