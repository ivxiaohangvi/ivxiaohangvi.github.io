#!/usr/bin/env node
/**
 * 把 dist 里所有阻塞渲染的 <link rel="stylesheet"> 改成非阻塞加载。
 *
 * 背景：Astro 打包出来的主样式表有 30–90 KB，放在 <head> 里就是渲染阻塞——
 * 在它下载完之前浏览器一个像素都不画，于是慢网络下先白屏十几秒，
 * 等样式到了加载层只闪一瞬。改成 media="print" 之后样式表不参与首屏渲染，
 * 加载完在 onload 里切回 media="all"，页面才应用样式。
 *
 * 另外给每个样式表配一条 <link rel="preload" as="style">：media="print" 的样式表
 * 在 Chrome 里是按低优先级下载的，不加 preload 反而可能比原来更晚到；preload 与
 * 随后的 stylesheet 指向同一个 URL，浏览器只会发一次请求。
 *
 * 首屏关键样式（加载层 + 页面底色）已经在 src/components/BaseHead.astro 里内联，
 * 所以样式没到位时看到的是加载层而不是白屏；加载层自己的脚本会等
 * `link[data-defer-style]` 的 sheet 挂上再撤。
 *
 * 同时补一份 <noscript> 的原始 <link>，禁用 JS 的浏览器照常拿到样式
 * （此时 BaseHead 里的 noscript 会把加载层直接藏掉）。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DIST = 'dist';
const STYLESHEET_LINK = /<link rel="stylesheet" href="([^"]+)"\s*\/?>/g;
// 幂等标记：只认「已经改成非阻塞」的那种 link。
// 不能用 html.includes('data-defer-style')——SiteLoader 的内联脚本里也写着这个选择器。
const DEFERRED_LINK =
  /<link rel="stylesheet" href="[^"]+" media="print" data-defer-style/;

async function* walkHtml(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkHtml(path);
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      yield path;
    }
  }
}

const files = [];
for await (const file of walkHtml(DIST)) files.push(file);

let touchedFiles = 0;
let deferredLinks = 0;
let skippedFiles = 0;

for (const file of files) {
  const html = await readFile(file, 'utf8');
  // 幂等：重复跑构建脚本时不叠加属性、不重复插 noscript
  if (DEFERRED_LINK.test(html)) {
    skippedFiles++;
    continue;
  }

  const hrefs = [];
  const transformed = html.replace(STYLESHEET_LINK, (_match, href) => {
    hrefs.push(href);
    deferredLinks++;
    return (
      `<link rel="preload" as="style" href="${href}">` +
      `<link rel="stylesheet" href="${href}" media="print" data-defer-style ` +
      `onload="this.media='all'" onerror="this.dataset.deferStyleError='1'">`
    );
  });

  if (hrefs.length === 0) continue;
  if (!transformed.includes('</head>')) {
    throw new Error(`${file}: 找不到 </head>，无法插入 noscript 兜底`);
  }

  const noscript = `<noscript>${hrefs
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join('')}</noscript>`;
  const output = transformed.replace('</head>', `${noscript}</head>`);

  await writeFile(file, output, 'utf8');
  touchedFiles++;
}

if (touchedFiles === 0 && skippedFiles > 0) {
  console.log(`[defer-stylesheets] 全部 ${skippedFiles} 个页面都已处理过，跳过`);
  process.exit(0);
}

if (touchedFiles === 0) {
  throw new Error(
    `没有改到任何 HTML（共扫描 ${files.length} 个，已处理过 ${skippedFiles} 个）。` +
      '是不是忘了先跑 astro build？',
  );
}

console.log(
  `[defer-stylesheets] ${touchedFiles} 个页面、${deferredLinks} 个样式表改为非阻塞加载` +
    (skippedFiles ? `（跳过 ${skippedFiles} 个已处理页面）` : ''),
);
