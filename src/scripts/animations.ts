/**
 * 全站动效入口：data-animate="hero-title" 首屏入场、data-reveal 滚动显影
 * （data-reveal="fade" 为纯淡入，给内部挂着绝对定位连线的区块用，
 * data-reveal-early 让重型区块提前到进视口前就显影）、
 * data-draw 单线绘制、首页夜航场景的常驻动效。
 * 滚动显影用 IntersectionObserver + CSS 过渡，每个元素只观察一次，
 * 不再为几百条列表项各建一个 ScrollTrigger。
 * ClientRouter 只执行一次脚本，所以每次 astro:page-load
 * 重建 context，并在 astro:before-swap 时 revert，避免跨页残留。
 */
import { gsap } from 'gsap';
import { MotionPathPlugin } from 'gsap/MotionPathPlugin';

gsap.registerPlugin(MotionPathPlugin);

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let ctx: gsap.Context | undefined;
let revealObservers: IntersectionObserver[] = [];

function observeReveals(root: ParentNode = document): void {
  if (revealObservers.length === 0) return;
  const [normal, early] = revealObservers;
  root.querySelectorAll<HTMLElement>('[data-reveal]').forEach((el) => {
    if (el.classList.contains('is-revealed')) return;
    (el.hasAttribute('data-reveal-early') ? early : normal).observe(el);
  });
}

function initReveals(): void {
  revealObservers.forEach((observer) => observer.disconnect());
  revealObservers = [];
  if (reduceMotion.matches) return;

  const make = (rootMargin: string) =>
    new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add('is-revealed');
          revealObservers.forEach((observer) => observer.unobserve(entry.target));
        }
      },
      { rootMargin },
    );

  // 'top 90%' 与 'top 130%' 的观察窗：early 让重型区块提前 30% 屏高开始显影
  const normal = make('0px 0px -10% 0px');
  const early = make('0px 0px 30% 0px');
  revealObservers = [normal, early];
  observeReveals();
}

function initAnimations(): void {
  ctx?.revert();
  ctx = undefined;

  initReveals();

  if (reduceMotion.matches) return;

  ctx = gsap.context(() => {
    document.querySelectorAll<HTMLElement>('[data-animate="hero-title"]').forEach((root) => {
      const targets = root.classList.contains('hero-main')
        ? [
            root.querySelector('.eyebrow'),
            ...root.querySelectorAll('.hero-line'),
            root.querySelector('.hero-lede'),
            root.querySelector('.hero-meta'),
          ].filter((el): el is Element => Boolean(el))
        : Array.from(root.children);

      if (targets.length === 0) return;

      gsap.from(targets, {
        y: 22,
        autoAlpha: 0,
        duration: 0.9,
        ease: 'power3.out',
        stagger: 0.08,
        clearProps: 'transform,translate,rotate,scale,opacity,visibility',
      });
    });

    gsap.utils.toArray<SVGPathElement>('[data-draw]').forEach((path) => {
      gsap.fromTo(
        path,
        { strokeDasharray: 1, strokeDashoffset: 1 },
        { strokeDashoffset: 0, duration: 2.2, ease: 'power2.inOut', delay: 0.25 },
      );
    });

    // 深夜的一句：虚线航线缓流、一枚光点沿路径巡游、星星呼吸、海面轻晃。
    // 虚线周期是 10 个用户单位，dashoffset 位移取整百保证循环无接缝
    const nightScene = document.querySelector('.night-scene');
    if (nightScene) {
      const route = nightScene.querySelector<SVGPathElement>('.night-route-line');
      const plane = nightScene.querySelector<SVGGElement>('.night-plane');
      if (route) {
        gsap.to(route, { strokeDashoffset: -100, duration: 9, ease: 'none', repeat: -1 });
      }
      if (route && plane) {
        gsap.set(plane, { opacity: 1 });
        gsap.to(plane, {
          motionPath: { path: route, align: route, alignOrigin: [0.5, 0.5] },
          duration: 17,
          ease: 'none',
          repeat: -1,
        });
      }
      const stars = nightScene.querySelectorAll('.night-star');
      if (stars.length > 0) {
        gsap.to(stars, {
          opacity: () => gsap.utils.random(0.15, 0.55),
          duration: () => gsap.utils.random(1.4, 2.8),
          ease: 'sine.inOut',
          repeat: -1,
          yoyo: true,
          stagger: { each: 0.4, from: 'random' },
        });
      }
      const sea = nightScene.querySelector('.night-sea');
      if (sea) {
        gsap.to(sea, { y: -4, duration: 6.5, ease: 'sine.inOut', repeat: -1, yoyo: true });
      }
    }
  });
}

document.addEventListener('astro:page-load', initAnimations);

document.addEventListener('moxo:ledger-updated', () => observeReveals());

document.addEventListener('astro:before-swap', () => {
  ctx?.revert();
  ctx = undefined;
  revealObservers.forEach((observer) => observer.disconnect());
  revealObservers = [];
});
