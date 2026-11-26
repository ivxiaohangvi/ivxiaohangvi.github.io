#!/usr/bin/env node
/**
 * 由 public/favicon.svg 生成搜索引擎/浏览器需要的位图 favicon。
 *
 * 为什么要位图：Bing 的站点图标（搜索列表左侧的小图标）只认站点根目录的
 * .ico/.png/.gif/.jpg 位图，不认 SVG；只有 SVG 时 Bing 会显示默认地球。
 *
 * 产物（均放在 public/，构建时原样拷到站点根目录）：
 *   - public/favicon.ico          16/32/48 三种尺寸（ICO 内以 PNG 编码）
 *   - public/favicon-16x16.png
 *   - public/favicon-32x32.png
 *   - public/apple-touch-icon.png 180×180，铺站点纸色底（避免 iOS 黑底）
 *
 * 用法：node scripts/build-favicons.mjs
 * 只在改动 favicon.svg 后需要重新执行，产物随仓库提交，不进入构建链。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const SVG_PATH = path.join(PUBLIC_DIR, 'favicon.svg');
const PAPER = { r: 0xe8, g: 0xe4, b: 0xd9, alpha: 1 };

/** ICO 里包含的尺寸。 */
const ICO_SIZES = [16, 32, 48];
/** 单独输出的 PNG。 */
const PNG_TARGETS = [
  { size: 16, file: 'favicon-16x16.png' },
  { size: 32, file: 'favicon-32x32.png' },
  { size: 180, file: 'apple-touch-icon.png', background: PAPER },
];

async function loadSharp() {
  try {
    const { default: sharp } = await import('sharp');
    return sharp;
  } catch (error) {
    throw new Error(`加载 sharp 失败（需要 npm install）：${error.message}`);
  }
}

/**
 * 把 SVG 渲染成指定边长的 PNG。
 * @param {typeof import('sharp')} sharp
 * @param {Buffer} svg
 * @param {number} size
 * @param {{ r: number, g: number, b: number, alpha: number }=} background
 * @returns {Promise<Buffer>}
 */
async function renderPng(sharp, svg, size, background) {
  // 先按较大的 density 栅格化，再缩到目标尺寸，小尺寸下描边更干净。
  let image = sharp(svg, { density: 1024 }).resize(size, size, { fit: 'contain' });
  if (background) image = image.flatten({ background });
  return image.png({ compressionLevel: 9 }).toBuffer();
}

/**
 * 组装 ICO 容器（ICONDIR + ICONDIRENTRY + PNG 数据，PNG 条目从 Vista 起通用）。
 * @param {{ size: number, buffer: Buffer }[]} images
 * @returns {Buffer}
 */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = icon
  header.writeUInt16LE(images.length, 4);

  const entries = Buffer.alloc(16 * images.length);
  let offset = header.length + entries.length;

  images.forEach(({ size, buffer }, index) => {
    const base = index * 16;
    // 256 用 0 表示，本脚本最大 48，直接写尺寸。
    entries.writeUInt8(size >= 256 ? 0 : size, base + 0);
    entries.writeUInt8(size >= 256 ? 0 : size, base + 1);
    entries.writeUInt8(0, base + 2); // 调色板颜色数
    entries.writeUInt8(0, base + 3); // reserved
    entries.writeUInt16LE(1, base + 4); // color planes
    entries.writeUInt16LE(32, base + 6); // bits per pixel
    entries.writeUInt32LE(buffer.length, base + 8);
    entries.writeUInt32LE(offset, base + 12);
    offset += buffer.length;
  });

  return Buffer.concat([header, entries, ...images.map(({ buffer }) => buffer)]);
}

/** 读取生成的 ICO 并做一次结构自检。 */
function verifyIco(buffer) {
  if (buffer.length < 6 || buffer.readUInt16LE(2) !== 1) throw new Error('ICO 头部不合法');
  const count = buffer.readUInt16LE(4);
  if (count !== ICO_SIZES.length) throw new Error(`ICO 尺寸数量不符：${count}`);
  for (let index = 0; index < count; index += 1) {
    const base = 6 + index * 16;
    const bytes = buffer.readUInt32LE(base + 8);
    const offset = buffer.readUInt32LE(base + 12);
    if (offset + bytes > buffer.length) throw new Error(`ICO 第 ${index} 个条目越界`);
    const signature = buffer.subarray(offset, offset + 4).toString('hex');
    if (signature !== '89504e47') throw new Error(`ICO 第 ${index} 个条目不是 PNG`);
  }
}

async function main() {
  const sharp = await loadSharp();
  const svg = await readFile(SVG_PATH);
  console.log(`[favicons] 源文件：${path.relative(ROOT, SVG_PATH)}（${svg.length} B）`);

  const written = [];
  for (const target of PNG_TARGETS) {
    const buffer = await renderPng(sharp, svg, target.size, target.background);
    const filePath = path.join(PUBLIC_DIR, target.file);
    await writeFile(filePath, buffer);
    written.push(`${target.file}（${target.size}×${target.size}，${buffer.length} B）`);
  }

  const icoImages = [];
  for (const size of ICO_SIZES) {
    icoImages.push({ size, buffer: await renderPng(sharp, svg, size) });
  }
  const ico = buildIco(icoImages);
  verifyIco(ico);
  await writeFile(path.join(PUBLIC_DIR, 'favicon.ico'), ico);
  written.push(`favicon.ico（${ICO_SIZES.join('/')}，${ico.length} B）`);

  for (const line of written) console.log(`[favicons] 已生成 public/${line}`);
}

main().catch((error) => {
  console.error(`[favicons] 生成失败：${error.message}`);
  process.exitCode = 1;
});
