// 渐进式图片升级：中画质载入且接近视口后，再预取原图并无缝替换。
// 三档链路：LQIP 背景（内联，首帧即有轮廓）→ 中画质（原生 lazy）→ 原图（这里升级）。
type PImg = HTMLImageElement & { dataset: { full?: string; upgraded?: string } };

let observer: IntersectionObserver | null = null;

function upgrade(img: PImg) {
  const full = img.dataset.full;
  if (!full || img.dataset.upgraded) return;
  img.dataset.upgraded = '1';

  const hi = new Image();
  hi.decoding = 'async';
  hi.onload = () => {
    // 原图已解码，换 src 不会闪白；LQIP 背景始终垫底，加载失败也留轮廓
    img.src = full;
    img.classList.add('is-full');
  };
  hi.onerror = () => {
    img.dataset.upgraded = '';
  };
  hi.src = full;
}

function whenMediumReady(img: PImg): Promise<void> {
  if (img.complete && img.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => resolve(), { once: true });
  });
}

function init() {
  observer?.disconnect();
  const images = Array.from(
    document.querySelectorAll<PImg>('img.pimg[data-full]:not([data-upgrade="off"])'),
  );
  if (images.length === 0) return;

  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target as PImg;
        observer?.unobserve(img);
        void whenMediumReady(img).then(() => upgrade(img));
      }
    },
    { rootMargin: '300px 0px' },
  );

  for (const img of images) observer.observe(img);
}

init();
document.addEventListener('astro:page-load', init);
