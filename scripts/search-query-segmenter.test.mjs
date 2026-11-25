import test from 'node:test';
import assert from 'node:assert/strict';

import { createVocabSegmenter } from '../src/lib/search-query-segmenter.ts';

/** 模拟「把中文按单字切」的浏览器（Safari / 部分 WebView 的已知退化行为）。 */
class CharSegmenter {
  constructor(locale, options) {
    this.options = options ?? {};
  }

  *segment(input) {
    for (let index = 0; index < input.length; index += 1) {
      yield { segment: input[index], index, input, isWordLike: true };
    }
  }

  resolvedOptions() {
    return { granularity: this.options.granularity ?? 'word' };
  }
}

const segh = (segmenter, input) => [...segmenter.segment(input)].map((part) => part.segment);

test('用词表最长匹配，逐字切词的浏览器也能得到正确词', () => {
  const Segmenter = createVocabSegmenter(['代码', '水怪', '小姑娘'], CharSegmenter);
  const segmenter = new Segmenter('zh-CN', { granularity: 'word' });
  assert.deepEqual(segh(segmenter, '代码'), ['代码']);
  assert.deepEqual(segh(segmenter, '小姑娘'), ['小姑娘']);
  // 词表里没有「小水怪」时切成「小」+「水怪」，比逐字切分更接近索引口径
  assert.deepEqual(segh(segmenter, '小水怪'), ['小', '水怪']);
});

test('词表外的中文按单字兜底', () => {
  const Segmenter = createVocabSegmenter([], CharSegmenter);
  assert.deepEqual(segh(new Segmenter('zh-CN', { granularity: 'word' }), '代码'), ['代', '码']);
});

test('非 word 粒度与非中文片段委托原生 Segmenter', () => {
  const Segmenter = createVocabSegmenter(['代码', '水怪', '小姑娘'], CharSegmenter);
  assert.deepEqual(segh(new Segmenter('zh-CN', { granularity: 'grapheme' }), '代码'), ['代', '码']);
  const word = new Segmenter('zh-CN', { granularity: 'word' });
  assert.deepEqual(segh(word, 'abc代码'), ['a', 'b', 'c', '代码']);
});

test('resolvedOptions 委托原生实现', () => {
  const Segmenter = createVocabSegmenter(['代码'], CharSegmenter);
  assert.deepEqual(new Segmenter('zh-CN', { granularity: 'word' }).resolvedOptions(), {
    granularity: 'word',
  });
});
