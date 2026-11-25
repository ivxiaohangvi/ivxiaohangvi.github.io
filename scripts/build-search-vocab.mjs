// 从 Pagefind 生成的 fragment 里抽出「索引真实切出的中文词」，供搜索页还原同一套切词口径。
//
// 背景：Pagefind 的查询端用浏览器自带的 Intl.Segmenter 切中文，索引端却是构建期固定分词。
// 两边口径不一致时（例如 Safari / 部分 WebView 会把中文按单字切），会出现「代码」这类词
// 搜不到、「小水怪」误命中只含「小」「水」「怪」单字页面的问题。搜索页加载本脚本产出的
// 词表后（src/lib/search-query-segmenter.ts），用最长匹配切查询词，两端口径就一致了。
//
// fragment 的 content 字段是展示用的分词（词之间用 U+200B 分隔，口径与索引不同，例如
// 「小水怪」会被拆成「小水」「怪」）。因此这里先去掉 U+200B 还原原文，再用构建机的
// Intl.Segmenter（与 Pagefind 1.6 索引端同一套 ICU 口径）重新切词；抽样用 Pagefind
// 精确搜索校验过，这样产出的词表与索引 term 对得上。
//
// 输出：dist/pagefind/vocab.zh.txt，每行一个词，按字典序排列。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const HAN_TOKEN = /^\p{Script=Han}{2,}$/u;
const SEGMENTER = new Intl.Segmenter('zh-CN', { granularity: 'word' });

/**
 * 从 fragment 的 content 字段里提取索引口径的中文词。
 * 先去掉 Pagefind 展示分词插入的 U+200B 还原原文，再用构建机 ICU 重新分词。
 * @param {string} content
 * @returns {Set<string>}
 */
export function extractTokens(content) {
  const plain = String(content ?? '').replace(/\u200b/g, '');
  const tokens = new Set();
  for (const part of SEGMENTER.segment(plain)) {
    // 只收纯中文、两字及以上的词：单字交给兜底逻辑，英文/数字交给原生 Segmenter。
    if (part.isWordLike && HAN_TOKEN.test(part.segment)) tokens.add(part.segment);
  }
  return tokens;
}

/**
 * 读取单个 fragment（gzip 的 JSON，去掉 "pagefind_dcd" 前缀）。
 * @param {Buffer} buffer
 */
export function parseFragment(buffer) {
  const text = zlib.gunzipSync(buffer).toString('utf8').replace(/^pagefind_dcd/, '');
  return JSON.parse(text);
}

/**
 * 扫描整个 fragment 目录，返回去重排序后的词表。
 * @param {string} fragmentDir
 * @returns {string[]}
 */
export function collectVocab(fragmentDir) {
  const vocab = new Set();
  for (const file of fs.readdirSync(fragmentDir)) {
    if (!file.endsWith('.pf_fragment')) continue;
    try {
      const fragment = parseFragment(fs.readFileSync(path.join(fragmentDir, file)));
      for (const token of extractTokens(fragment.content)) vocab.add(token);
    } catch (error) {
      console.warn(`[search-vocab] 跳过无法解析的 fragment ${file}：${error.message}`);
    }
  }
  return [...vocab].sort();
}

/**
 * 生成词表文件，返回词数与字节数。
 * @param {string} siteDir 站点输出目录（含 pagefind/）
 */
export function buildVocabFile(siteDir) {
  const fragmentDir = path.join(siteDir, 'pagefind', 'fragment');
  if (!fs.existsSync(fragmentDir)) {
    throw new Error(`找不到 ${fragmentDir}，请先运行 pagefind 构建索引`);
  }
  const vocab = collectVocab(fragmentDir);
  if (vocab.length === 0) {
    throw new Error(`${fragmentDir} 里没有提取到中文词，请检查 Pagefind 版本或语言配置`);
  }
  const text = `${vocab.join('\n')}\n`;
  const outFile = path.join(siteDir, 'pagefind', 'vocab.zh.txt');
  fs.writeFileSync(outFile, text);
  return { count: vocab.length, bytes: Buffer.byteLength(text), outFile };
}

function main() {
  const siteDir = path.resolve(process.argv[2] ?? 'dist');
  try {
    const { count, bytes, outFile } = buildVocabFile(siteDir);
    const kb = (bytes / 1024).toFixed(1);
    console.log(`[search-vocab] ${count} 个索引词 → ${path.relative(process.cwd(), outFile)}（${kb} KB）`);
  } catch (error) {
    console.error(`[search-vocab] ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
