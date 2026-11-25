import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { buildVocabFile, collectVocab, extractTokens } from './build-search-vocab.mjs';

function makeFragment(content) {
  return zlib.gzipSync(`pagefind_dcd${JSON.stringify({ url: '/diary/x/', content })}`);
}

test('extractTokens 只收两字及以上的纯中文词', () => {
  const content = [
    '代码',
    '水怪',
    '',
    '单', // 单字中文不要
    'abc', // 英文不要
    '42', // 数字不要
    '星期',
  ].join('\u200b');
  assert.deepEqual([...extractTokens(content)], ['代码', '水怪', '星期']);
});

test('extractTokens 处理空内容', () => {
  assert.equal(extractTokens(undefined).size, 0);
  assert.equal(extractTokens('').size, 0);
});

test('collectVocab 跨 fragment 去重并排序', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-vocab-'));
  fs.writeFileSync(path.join(dir, 'a.pf_fragment'), makeFragment('水怪\u200b代码\u200b单'));
  fs.writeFileSync(path.join(dir, 'b.pf_fragment'), makeFragment('代码\u200b小姑娘'));
  fs.writeFileSync(path.join(dir, 'ignore.txt'), 'x');
  assert.deepEqual(collectVocab(dir), ['代码', '小姑娘', '水怪']);
});

test('collectVocab 跳过损坏的 fragment 而不是整体失败', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-vocab-bad-'));
  fs.writeFileSync(path.join(dir, 'bad.pf_fragment'), 'not gzip');
  fs.writeFileSync(path.join(dir, 'ok.pf_fragment'), makeFragment('阿姨\u200b声音'));
  assert.deepEqual(collectVocab(dir), ['声音', '阿姨']);
});

test('buildVocabFile 写出 pagefind/vocab.zh.txt', () => {
  const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-vocab-site-'));
  fs.mkdirSync(path.join(siteDir, 'pagefind', 'fragment'), { recursive: true });
  fs.writeFileSync(
    path.join(siteDir, 'pagefind', 'fragment', 'a.pf_fragment'),
    makeFragment('代码\u200b水怪'),
  );
  const result = buildVocabFile(siteDir);
  assert.equal(result.count, 2);
  assert.equal(fs.readFileSync(path.join(siteDir, 'pagefind', 'vocab.zh.txt'), 'utf8'), '代码\n水怪\n');
});

test('buildVocabFile 在没有索引时报错', () => {
  const siteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search-vocab-empty-'));
  assert.throws(() => buildVocabFile(siteDir), /请先运行 pagefind/);
});
