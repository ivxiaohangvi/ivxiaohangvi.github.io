import test from 'node:test';
import assert from 'node:assert/strict';

import { typeWordIntoSearch } from '../src/lib/search-typing.ts';

const instant = async () => {};

function recorder() {
  const events = [];
  return {
    events,
    hooks: {
      setValue: (value) => events.push({ kind: 'value', value }),
      compose: (text) => events.push({ kind: 'compose', text }),
      candidates: (chars, active) => events.push({ kind: 'candidates', chars, active }),
      hideIme: () => events.push({ kind: 'hide' }),
    },
  };
}

function run(word, syllables, extra = {}) {
  const { events, hooks } = recorder();
  const promise = typeWordIntoSearch({
    word,
    syllables,
    hooks,
    wait: instant,
    random: () => 0,
    ...extra,
  });
  return { events, promise };
}

test('逐字打出：全拼组合区 → 候选 → 落字，没有退格与暗色', async () => {
  const { events, promise } = run('水怪', ['shui', 'guai'], {
    candidatesFor: (syllable, char) => (syllable === 'shui' ? [char, '睡'] : [char, '乖']),
  });
  assert.equal(await promise, true);

  const composed = events.filter((event) => event.kind === 'compose').map((event) => event.text);
  assert.deepEqual(composed, ['s', 'sh', 'shu', 'shui', '', 'g', 'gu', 'gua', 'guai', '']);

  const values = events.filter((event) => event.kind === 'value').map((event) => event.value);
  // 只出现已经敲定的字，逐字增长，不会回退（没有打错字再删）。
  assert.deepEqual(values, ['水', '水怪']);

  const candidates = events.filter((event) => event.kind === 'candidates');
  assert.deepEqual(candidates[0].chars, ['水', '睡']);
  assert.deepEqual(candidates[1].chars, ['怪', '乖']);
  assert.equal(candidates[0].active, 0);

  assert.equal(events.at(-1).kind, 'hide');
});

test('目标字总是候选第一项（词表里查不到同音字时也不为空）', async () => {
  const { events, promise } = run('代码', ['dai', 'ma'], {
    candidatesFor: (_syllable, char) => [char],
  });
  await promise;
  const candidates = events.filter((event) => event.kind === 'candidates');
  assert.deepEqual(
    candidates.map((event) => event.chars[0]),
    ['代', '码'],
  );
});

test('缺少拼音数据时只落字，不弹输入法面板', async () => {
  const { events, promise } = run('水怪', []);
  assert.equal(await promise, true);
  assert.equal(events.some((event) => event.kind === 'compose'), false);
  assert.equal(events.some((event) => event.kind === 'candidates'), false);
  assert.deepEqual(
    events.filter((event) => event.kind === 'value').map((event) => event.value),
    ['水', '水怪'],
  );
});

test('英文/数字没有输入法，直接逐字落字', async () => {
  const { events, promise } = run('astro代码', ['a', 's', 't', 'r', 'o', 'dai', 'ma']);
  assert.equal(await promise, true);
  const composed = events.filter((event) => event.kind === 'compose').map((event) => event.text);
  assert.deepEqual(composed, ['d', 'da', 'dai', '', 'm', 'ma', '']);
  assert.equal(events.at(-2).value, 'astro代码');
});

test('减少动态效果：直接写入完整词并收起面板', async () => {
  const { events, promise } = run('水怪', ['shui', 'guai'], { reduceMotion: true });
  assert.equal(await promise, true);
  assert.deepEqual(events, [{ kind: 'value', value: '水怪' }, { kind: 'hide' }]);
});

test('中途被打断：返回 false、收起面板，不写入完整词', async () => {
  let checks = 0;
  const { events, promise } = run('水怪', ['shui', 'guai'], {
    isCancelled: () => {
      checks += 1;
      return checks > 3;
    },
  });
  assert.equal(await promise, false);
  const values = events.filter((event) => event.kind === 'value').map((event) => event.value);
  assert.equal(values.includes('水怪'), false);
  assert.equal(events.at(-1).kind, 'hide');
});
