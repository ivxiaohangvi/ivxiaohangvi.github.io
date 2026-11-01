/**
 * Steam 留言内容的唯一清洗入口。
 * parse5 解析成 AST 后按白名单重建，输出只可能是 <br>、<a>、<img> 和转义文本；
 * 不再有正则切标签，也不接受任何原始标签或裸 '<' 透传。
 */
import { parseFragment } from 'parse5';

const STEAM_HOST = /(^|\.)steamcommunity\.com$/i;
const CDN_HOST = /(^|\.)steamstatic\.com$/i;
const MAX_DEPTH = 64;

const HOST_MAP = {
  'avatars.cdn.queniuqe.com': 'avatars.steamstatic.com',
  'shared.cdn.queniuqe.com': 'shared.fastly.steamstatic.com',
  'community.cdn.queniuqe.com': 'community.fastly.steamstatic.com',
  'cdn.queniuqe.com': 'community.fastly.steamstatic.com',
};

// 这些元素的子文本不是给人读的正文，整棵丢掉
const DROP_SUBTREE = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'canvas',
  'audio',
  'video',
  'head',
  'title',
  'base',
  'meta',
  'link',
  'textarea',
  'select',
  'frame',
  'frameset',
  'plaintext',
  'xmp',
]);

export function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (match, hex) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return match;
      }
    })
    .replace(/&#(\d+);/g, (match, num) => {
      try {
        return String.fromCodePoint(Number(num));
      } catch {
        return match;
      }
    })
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Steam 中国加速器会把 CDN 域名改写成 queniuqe.com，统一还原 */
function toHttpsUrl(raw) {
  if (typeof raw !== 'string') return '';
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return '';
  }
  if (HOST_MAP[url.hostname]) url.hostname = HOST_MAP[url.hostname];
  if (url.protocol === 'http:') url.protocol = 'https:';
  return url.href;
}

/** 用于同步脚本里从原始 HTML 抠出的属性（可能还带着实体） */
export function normalizeSteamUrl(raw) {
  return toHttpsUrl(decodeEntities(raw));
}

/** 资料链接只认 Steam 官方域名；渲染层也会再校验一次 JSON */
export function normalizeSteamProfileUrl(raw) {
  const href = toHttpsUrl(raw);
  if (!href) return '';
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:' || !STEAM_HOST.test(url.hostname)) return '';
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return '';
  }
}

function safeHref(raw, depth = 0) {
  if (depth > 3) return '';
  const href = toHttpsUrl(raw);
  if (!href) return '';
  let url;
  try {
    url = new URL(href);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:') return '';
  url.username = '';
  url.password = '';

  if (
    (url.hostname === 'steamcommunity.com' || url.hostname === 'www.steamcommunity.com') &&
    url.pathname === '/linkfilter/'
  ) {
    const target = url.searchParams.get('u');
    return target ? safeHref(target, depth + 1) : '';
  }

  return url.href;
}

function safeImageSrc(raw) {
  const href = toHttpsUrl(raw);
  if (!href) return '';
  let url;
  try {
    url = new URL(href);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || !CDN_HOST.test(url.hostname)) return '';
  url.username = '';
  url.password = '';
  return url.href;
}

function escapeText(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getAttr(node, name) {
  if (!Array.isArray(node.attrs)) return '';
  const found = node.attrs.find((attr) => attr.name === name);
  return found ? found.value : '';
}

function serializeChildren(node, depth, inAnchor) {
  if (depth > MAX_DEPTH) return '';
  let out = '';
  for (const child of node.childNodes ?? []) {
    out += serializeNode(child, depth + 1, inAnchor);
  }
  return out;
}

function serializeNode(node, depth, inAnchor) {
  switch (node.nodeName) {
    case '#text':
      return escapeText(node.value);
    case '#comment':
      return '';
    case 'br':
      return '<br>';
    case 'img': {
      const src = safeImageSrc(getAttr(node, 'src'));
      if (!src) return '';
      const alt = getAttr(node, 'alt').replace(/\s+/g, ' ').trim().slice(0, 200);
      return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" class="emoticon" loading="lazy" decoding="async">`;
    }
    case 'a': {
      if (inAnchor) return serializeChildren(node, depth, true);
      const inner = serializeChildren(node, depth, true);
      const href = safeHref(getAttr(node, 'href'));
      if (!href) return inner;
      return `<a href="${escapeAttr(href)}" rel="nofollow noopener noreferrer" target="_blank">${inner}</a>`;
    }
    default:
      if (DROP_SUBTREE.has(node.nodeName)) return '';
      return serializeChildren(node, depth, inAnchor);
  }
}

export function sanitizeSteamContent(html) {
  if (typeof html !== 'string' || !html.trim()) return '';
  let fragment;
  try {
    fragment = parseFragment(html);
  } catch {
    return '';
  }
  // 只削掉外层 ASCII 空白；全角空格和盲文空白是字符画的一部分，不能动
  return serializeChildren(fragment, 0, false).replace(/^[\t\r\n\f ]+|[\t\r\n\f ]+$/g, '');
}
