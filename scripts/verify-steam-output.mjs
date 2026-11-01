/**
 * 构建产物审计：Steam 留言区域只允许白名单标签与属性。
 * `npm run build` 在 astro build 之后、pagefind 之前运行；有问题直接让构建失败。
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseFragment } from 'parse5';

const DIST = path.resolve('dist');
const COMMENT_TAGS = new Set(['br', 'a', 'img']);
const ANCHOR_ATTRS = new Set(['href', 'rel', 'target']);
const IMAGE_ATTRS = new Set(['src', 'alt', 'class', 'loading', 'decoding']);
const FORBIDDEN_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'meta',
  'link',
  'base',
]);

const errors = [];
let pages = 0;
let comments = 0;

function attrsOf(node) {
  return new Map((node.attrs ?? []).map((attr) => [attr.name, attr.value]));
}

function classSet(node) {
  return new Set((attrsOf(node).get('class') ?? '').split(/\s+/).filter(Boolean));
}

function walk(node, visit) {
  if (node.tagName) visit(node);
  for (const child of node.childNodes ?? []) walk(child, visit);
  if (node.content) walk(node.content, visit);
}

function textOf(node) {
  let text = '';
  for (const child of node.childNodes ?? []) {
    if (child.nodeName === '#text') text += child.value ?? '';
    else text += textOf(child);
  }
  return text.trim();
}

function checkUrl(value, label, { allowRelative = false } = {}) {
  if (allowRelative && (value.startsWith('/') || value.startsWith('#'))) return;
  let url;
  try {
    url = new URL(value, 'https://moxo.cc');
  } catch {
    errors.push(`${label}: URL 无法解析 ${JSON.stringify(value)}`);
    return;
  }
  if (url.protocol !== 'https:') {
    errors.push(`${label}: 非 https URL ${JSON.stringify(value)}`);
  }
}

function auditComment(node, label) {
  walk(node, (child) => {
    if (child === node) return;
    if (!COMMENT_TAGS.has(child.tagName)) {
      errors.push(`${label}: 留言里出现 <${child.tagName}>`);
      return;
    }
    const attrs = attrsOf(child);
    for (const name of attrs.keys()) {
      if (name.startsWith('on')) errors.push(`${label}: 留言里残留事件属性 ${name}`);
      if (name === 'style') errors.push(`${label}: 留言里残留 style`);
    }
    if (child.tagName === 'br') {
      if (attrs.size) errors.push(`${label}: <br> 带属性`);
      return;
    }
    if (child.tagName === 'a') {
      for (const name of attrs.keys()) {
        if (!ANCHOR_ATTRS.has(name)) errors.push(`${label}: <a> 多余属性 ${name}`);
      }
      const href = attrs.get('href') ?? '';
      if (!href.startsWith('https://')) errors.push(`${label}: a.href 不是 https`);
      if (attrs.get('rel') !== 'nofollow noopener noreferrer') {
        errors.push(`${label}: a.rel 异常`);
      }
      if (attrs.get('target') !== '_blank') errors.push(`${label}: a.target 异常`);
      return;
    }
    for (const name of attrs.keys()) {
      if (!IMAGE_ATTRS.has(name)) errors.push(`${label}: <img> 多余属性 ${name}`);
    }
    const src = attrs.get('src') ?? '';
    let url;
    try {
      url = new URL(src);
    } catch {
      errors.push(`${label}: img.src 无法解析`);
      return;
    }
    if (url.protocol !== 'https:' || !/(^|\.)steamstatic\.com$/i.test(url.hostname)) {
      errors.push(`${label}: img.src 越界 ${JSON.stringify(src)}`);
    }
  });
}

const files = await readdir(DIST, { recursive: true });
for (const relative of files) {
  if (!relative.endsWith('.html')) continue;
  const html = await readFile(path.join(DIST, relative), 'utf8');
  if (!html.includes('steam-note-text')) continue;
  pages += 1;

  const fragment = parseFragment(html);
  const sections = [];
  walk(fragment, (node) => {
    if (node.tagName === 'section' && classSet(node).has('steam-notes')) sections.push(node);
  });
  if (!sections.length) {
    errors.push(`${relative}: 有留言内容但缺少 steam-notes 容器`);
    continue;
  }

  for (const section of sections) {
    // 同一个人（profileUrl）在同一页只能出现一个名字，否则说明合并回来的旧昵称漏出去了
    const namesByProfile = new Map();
    const avatarSrcs = new Set();

    walk(section, (node) => {
      if (FORBIDDEN_TAGS.has(node.tagName)) {
        errors.push(`${relative}: Steam 区出现 <${node.tagName}>`);
      }
      const attrs = attrsOf(node);
      for (const name of attrs.keys()) {
        if (name.startsWith('on')) errors.push(`${relative}: Steam 区残留事件属性 ${name}`);
      }
      if (attrs.has('href')) {
        checkUrl(attrs.get('href'), `${relative} href`, { allowRelative: true });
      }
      if (attrs.has('src')) {
        checkUrl(attrs.get('src'), `${relative} src`, { allowRelative: true });
      }
      if (classSet(node).has('steam-note-name')) {
        const href = attrs.get('href') ?? '';
        if (href) {
          const names = namesByProfile.get(href) ?? new Set();
          names.add(textOf(node));
          namesByProfile.set(href, names);
        }
      }
      if (classSet(node).has('steam-note-avatar')) {
        for (const child of node.childNodes ?? []) {
          if (child.tagName === 'img') avatarSrcs.add(attrsOf(child).get('src') ?? '');
        }
      }
      if (classSet(node).has('steam-note-text')) {
        comments += 1;
        auditComment(node, `${relative} 第 ${comments} 条`);
      }
    });

    for (const [href, names] of namesByProfile) {
      if (names.size > 1) {
        errors.push(`${relative}: ${href} 出现多个名字（${[...names].join(' / ')}）`);
      }
    }

    for (const src of avatarSrcs) {
      if (!src || !src.startsWith('/')) continue;
      const file = path.join(DIST, decodeURIComponent(src).replace(/^\//, ''));
      if (!existsSync(file)) errors.push(`${relative}: 头像文件不存在 ${src}`);
    }
  }
}

if (!pages) {
  console.log('[verify] 未发现 Steam 留言产物，跳过审计');
  process.exit(0);
}

if (errors.length) {
  console.error(`[verify] Steam 留言产物审计失败（${errors.length} 项）：`);
  for (const error of errors.slice(0, 30)) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`[verify] 已审计 ${pages} 个页面、${comments} 条留言，全部通过白名单`);
