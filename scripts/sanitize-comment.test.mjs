import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseFragment } from 'parse5';
import {
  normalizeSteamProfileUrl,
  normalizeSteamUrl,
  sanitizeSteamContent,
} from '../src/lib/sanitize-comment.js';

const ROOT = process.cwd();
const ALLOWED_TAGS = new Set(['br', 'a', 'img']);
const ANCHOR_ATTRS = new Set(['href', 'rel', 'target']);
const IMAGE_ATTRS = new Set(['src', 'alt', 'class', 'loading', 'decoding']);

function elements(html) {
  const fragment = parseFragment(html);
  const found = [];
  const walk = (node) => {
    if (node.tagName) found.push(node);
    for (const child of node.childNodes ?? []) walk(child);
    if (node.content) walk(node.content);
  };
  walk(fragment);
  return found;
}

function assertSafe(html, label = 'html') {
  for (const node of elements(html)) {
    assert.ok(ALLOWED_TAGS.has(node.tagName), `${label}: 出现了白名单外的 <${node.tagName}>`);
    const attrs = new Map(node.attrs.map((attr) => [attr.name, attr.value]));

    for (const name of attrs.keys()) {
      assert.ok(!name.startsWith('on'), `${label}: 残留事件属性 ${name}`);
      assert.notEqual(name, 'style', `${label}: 残留 style`);
    }

    if (node.tagName === 'br') {
      assert.equal(attrs.size, 0, `${label}: <br> 不应带属性`);
    }

    if (node.tagName === 'a') {
      for (const name of attrs.keys()) {
        assert.ok(ANCHOR_ATTRS.has(name), `${label}: <a> 出现多余属性 ${name}`);
      }
      assert.ok(attrs.get('href')?.startsWith('https://'), `${label}: a.href 不是 https`);
      assert.equal(attrs.get('rel'), 'nofollow noopener noreferrer');
      assert.equal(attrs.get('target'), '_blank');
    }

    if (node.tagName === 'img') {
      for (const name of attrs.keys()) {
        assert.ok(IMAGE_ATTRS.has(name), `${label}: <img> 出现多余属性 ${name}`);
      }
      const src = new URL(attrs.get('src'));
      assert.equal(src.protocol, 'https:', `${label}: img.src 不是 https`);
      assert.match(src.hostname, /(^|\.)steamstatic\.com$/i, `${label}: img.src 域名越界`);
      assert.equal(attrs.get('class'), 'emoticon');
    }
  }
}

function sanitize(html) {
  const output = sanitizeSteamContent(html);
  assertSafe(output, JSON.stringify(html));
  assert.equal(sanitizeSteamContent(output), output, '清洗应当幂等');
  return output;
}

test('拒绝非 http(s) 协议与相对链接', () => {
  const hrefs = [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'javascript&#58;alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///C:/Windows/win.ini',
    'mailto:test@example.com',
    '/relative/path',
    '//evil.example/path',
  ];
  for (const href of hrefs) {
    const output = sanitize(`<a href="${href}">可点击文字</a>`);
    assert.ok(!output.includes('<a '), `${href} 不应保留为链接`);
    assert.ok(output.includes('可点击文字'), `${href} 的文字不应丢失`);
  }
});

test('未闭合标签与裸 < 不会在页面里复活成元素', () => {
  const payloads = [
    'hello <img src=x onerror=alert(1)//',
    'hello <svg/onload=alert(1)//',
    'hello <img src=x onerror=alert(1)//</div>',
    'hello < if (a > b) alert(1)',
    'a < b & c',
  ];
  for (const payload of payloads) {
    const output = sanitize(payload);
    assert.ok(!output.includes('onerror'), `${payload} 的 onerror 不应出现在输出`);
    const wrapped = `<div class="steam-note-text">${output}</div>`;
    const nodes = elements(wrapped).filter((node) => node.tagName !== 'div');
    assert.equal(nodes.length, 0, `${payload} 不应把文本解析成标签`);
    assert.equal(
      elements(wrapped).some((node) => node.attrs.some((attr) => attr.name.startsWith('on'))),
      false
    );
  }
  assert.equal(sanitize('a < b & c'), 'a &lt; b &amp; c');
});

test('srcdoc 与 mXSS 组合被整体清掉', () => {
  const payloads = [
    '<iframe srcdoc="<script>alert(1)</script>">x</iframe>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<svg><p><style><a id="</style><img src=x onerror=alert(1)>">',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
  ];
  for (const payload of payloads) {
    const output = sanitize(payload);
    assert.ok(!output.includes('<img'), `${payload} 不应留下 img 标签`);
    assert.ok(!output.includes('<iframe'), `${payload} 不应留下 iframe 标签`);
  }
});

test('正常链接与 Steam 表情保留，但属性重建', () => {
  const output = sanitize(
    '<a href="https://example.com/path?a=1&amp;b=2" onclick="alert(1)" style="color:red">外链</a><br>' +
      '<img src="https://community.fastly.steamstatic.com/economy/emoticon/foo?x=1" onerror="alert(1)" alt=":foo:">'
  );
  assert.ok(output.includes('rel="nofollow noopener noreferrer"'));
  assert.ok(output.includes('target="_blank"'));
  assert.ok(!output.includes('onclick'));
  assert.ok(!output.includes('onerror'));
  assert.ok(!output.includes('style='));
  assert.ok(output.includes('alt=":foo:"'));
  const anchor = elements(output).find((node) => node.tagName === 'a');
  assert.equal(
    anchor.attrs.find((attr) => attr.name === 'href').value,
    'https://example.com/path?a=1&b=2'
  );
});

test('图片域名白名单阻止伪装域名', () => {
  for (const src of [
    'https://evil.example/x.png',
    'https://steamstatic.com.evil.example/x.png',
    'https://evilsteamstatic.com/x.png',
    'https://avatars.steamstatic.com.evil.example/x.png',
    'http://steamcommunity.com/x.png',
  ]) {
    assert.equal(sanitize(`<img src="${src}">`), '');
  }
  assert.ok(
    sanitize('<img src="https://avatars.steamstatic.com/abc.webp">').startsWith('<img ')
  );
});

test('Steam linkfilter 解开后仍走协议校验', () => {
  const ok = sanitize(
    '<a href="https://steamcommunity.com/linkfilter/?u=https%3A%2F%2Fexample.com%2Fpost">帖子</a>'
  );
  assert.ok(ok.includes('href="https://example.com/post"'));
  const nested = sanitize(
    `<a href="https://steamcommunity.com/linkfilter/?u=${encodeURIComponent(
      'https://steamcommunity.com/linkfilter/?u=https://example.com/nested'
    )}">嵌套</a>`
  );
  assert.ok(nested.includes('href="https://example.com/nested"'));
  const bad = sanitize(
    '<a href="https://steamcommunity.com/linkfilter/?u=javascript%3Aalert(1)">坏链接</a>'
  );
  assert.equal(bad, '坏链接');
  assert.equal(sanitize('<a href="https://steamcommunity.com/linkfilter/">空参数</a>'), '空参数');
});

test('http 外链升级为 https，HTML 实体只解码一次', () => {
  const output = sanitize('<a href="http://example.com/a?x=1&amp;y=2">x</a>');
  assert.ok(output.includes('href="https://example.com/a?x=1&amp;y=2"'));
  assert.equal(sanitize('&lt;script&gt;alert(1)&lt;/script&gt;'), '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('普通标签剥壳留字，危险子树整棵丢弃', () => {
  assert.equal(sanitize('<b>粗体</b><span>文字</span>'), '粗体文字');
  assert.equal(sanitize('<p>段落</p>'), '段落');
  assert.equal(sanitize('<script>alert(1)</script>'), '');
  assert.equal(sanitize('<style>body{display:none}</style>'), '');
  assert.equal(sanitize('<template><img src="https://avatars.steamstatic.com/x.webp"></template>'), '');
});

test('ASCII 画与换行、空格不被破坏', () => {
  const art = '　╭────╮<br>　│ ∞ │<br>　╰────╯';
  const output = sanitize(art);
  assert.equal(output, '　╭────╮<br>　│ ∞ │<br>　╰────╯');
  assert.equal(sanitize('第一行\n第二行'), '第一行\n第二行');
});

test('资料链接只放行 Steam 官方 https', () => {
  assert.equal(
    normalizeSteamProfileUrl('https://steamcommunity.com/id/IVxiaohangVI/'),
    'https://steamcommunity.com/id/IVxiaohangVI/'
  );
  assert.equal(
    normalizeSteamProfileUrl('http://steamcommunity.com/id/x/'),
    'https://steamcommunity.com/id/x/'
  );
  for (const raw of [
    'javascript:alert(1)',
    'https://steamcommunity.com.evil.example/id/x/',
    'https://evil.example/?next=steamcommunity.com',
    '',
  ]) {
    assert.equal(normalizeSteamProfileUrl(raw), '');
  }
});

test('CDN 域名还原与协议升级', () => {
  assert.equal(
    normalizeSteamUrl('https://avatars.cdn.queniuqe.com/x.jpg'),
    'https://avatars.steamstatic.com/x.jpg'
  );
  assert.equal(
    normalizeSteamUrl('http://community.cdn.queniuqe.com/y.png'),
    'https://community.fastly.steamstatic.com/y.png'
  );
  assert.equal(normalizeSteamUrl('not a url'), '');
});

test('现有快照逐条通过白名单与幂等检查', async () => {
  const snapshot = JSON.parse(
    await readFile(path.join(ROOT, 'src/data/steam-comments.json'), 'utf8')
  );
  for (const comment of snapshot.comments) {
    const output = sanitize(comment.html);
    assert.equal(typeof output, 'string');
  }
});
