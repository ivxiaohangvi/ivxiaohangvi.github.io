// 活体 ∞：一段黄铜弧沿环巡游（GSAP tween 驱动，悬停只调 timeScale，不碰相位）。
// 弧长与位移都取路径的实际长度，虚线正好铺满一整圈——
// tween 每个 repeat 从 -(相位*len) 走到 -(相位*len+len)，位移差恰好等于一个虚线周期，
// 所以 repeat 边界看过去仍是一条不断头的环。换页时记录相位接续，不从头起步。
import { gsap } from 'gsap';

type Mark = {
  flow: SVGPathElement;
  len: number;
  host: Element | null;
  tween: gsap.core.Tween | null;
  speedTween: gsap.core.Tween | null;
};

const LAP_SECONDS = 6.4;
const HOVER_SPEED = 3.2;
const SPEED_RAMP = 0.45;

let marks: Mark[] = [];
let phase = 0;
const calm = window.matchMedia('(prefers-reduced-motion: reduce)');

function teardown(): void {
  for (const mark of marks) {
    mark.speedTween?.kill();
    mark.tween?.kill();
  }
  marks = [];
}

function collect(): void {
  teardown();
  marks = Array.from(document.querySelectorAll<SVGPathElement>('.live-inf-flow')).flatMap((flow) => {
    const svg = flow.ownerSVGElement;
    if (!svg) return [];
    const len = flow.getTotalLength() || 1;
    const arc = Math.min(60, Math.max(4, Number(svg.dataset.arc) || 16)) / 100;
    flow.style.strokeDasharray = `${(len * arc).toFixed(2)} ${(len * (1 - arc)).toFixed(2)}`;
    // 换页时接着上一段的相位走，不从头起步
    return [{ flow, len, host: svg.closest('.brand, .footer-brand'), tween: null, speedTween: null }];
  });
}

function rampSpeed(mark: Mark, target: number): void {
  if (!mark.tween) return;
  mark.speedTween?.kill();
  mark.speedTween = gsap.to(mark.tween, {
    timeScale: target,
    duration: SPEED_RAMP,
    ease: 'power2.out',
    overwrite: true,
  });
}

function build(): void {
  if (calm.matches) return;

  marks.forEach((mark, index) => {
    const start = -(phase * mark.len);
    mark.tween = gsap.fromTo(
      mark.flow,
      { strokeDashoffset: start },
      {
        strokeDashoffset: start - mark.len,
        duration: LAP_SECONDS,
        ease: 'none',
        repeat: -1,
        // 首条 tween 的迭代进度就是全局相位，换页时从这里接续
        onUpdate:
          index === 0
            ? () => {
                if (mark.tween) phase = mark.tween.progress();
              }
            : undefined,
      },
    );

    if (!mark.host) return;
    mark.host.addEventListener('pointerenter', () => rampSpeed(mark, HOVER_SPEED));
    mark.host.addEventListener('pointerleave', () => rampSpeed(mark, 1));
  });
}

function init(): void {
  collect();
  build();
}

init();
document.addEventListener('astro:page-load', init);
document.addEventListener('astro:before-swap', teardown);
calm.addEventListener('change', init);
