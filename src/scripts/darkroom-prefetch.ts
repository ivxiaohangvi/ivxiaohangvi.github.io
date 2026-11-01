// 暗房模型的后台预取：把 4.9MB 的 glb 静默缓存进 Cache Storage，
// 让 /infinity/ 的进入速度不受首次下载拖累。规则见 src/lib/darkroom.ts。
// 默认空闲预取；页面可以把 body[data-darkroom-prefetch] 设成 intent，
// 改成只有悬停/聚焦暗房入口、或指针进入底栏时才立即预取（日记列表就用这个，
// 免得列表首屏和 4.9MB 抢带宽）。
import { prefetchDarkroomModel } from '../lib/darkroom';

let detachIntent: (() => void) | null = null;

function detach(): void {
  detachIntent?.();
  detachIntent = null;
}

function boot(): void {
  detach();

  if (document.body.dataset.darkroomPrefetch !== 'intent') {
    prefetchDarkroomModel();
    return;
  }

  const footer = document.querySelector<HTMLElement>('.site-footer');
  const link = document.querySelector<HTMLAnchorElement>('.site-footer a[href*="/infinity"]');
  if (!footer && !link) return;

  const eager = () => {
    prefetchDarkroomModel({ eager: true });
    detach();
  };

  link?.addEventListener('pointerover', eager);
  link?.addEventListener('focusin', eager);
  footer?.addEventListener('pointerenter', eager);

  detachIntent = () => {
    link?.removeEventListener('pointerover', eager);
    link?.removeEventListener('focusin', eager);
    footer?.removeEventListener('pointerenter', eager);
  };
}

boot();
document.addEventListener('astro:page-load', boot);
document.addEventListener('astro:before-swap', detach);
