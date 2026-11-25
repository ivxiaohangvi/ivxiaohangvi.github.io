import test from 'node:test';
import assert from 'node:assert/strict';

import { composeLabel, typeWordIntoSearch } from '../src/lib/search-typing.ts';

const instant = async () => {};

function recorder() {
  const events = [];
  return {
    events,
    hooks: {
      setValue: (value) => events.push({ kind: 'value', value }),
      compose: (text) => events.push({ kind: 'compose', text }),
      candidates: (items, active) => events.push({ kind: 'candidates', items, active }),
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

test('composeLabel：满一个音节后插入全拼分隔符', () => {
  assert.equal(composeLabel(['shui', 'guai'], 'shu'), 'shu');
  assert.equal(composeLabel(['shui', 'guai'], 'shuig'), "shui'g");
  assert.equal(composeLabel(['shui', 'guai'], 'shuiguai'), "shui'guai");
  assert.equal(composeLabel(['yu'], 'yu'), 'yu');
});

test('整词连打：拼音连续进组合区（音节间用 ' + "'" + ' 分隔），最后整词落字', async () => {
  const { events, promise } = run('水怪', ['shui', 'guai'], {
    charCandidatesFor: (syllable, char) => (syllable === 'shui' ? [char, '睡'] : [char, '乖']),
    wordCandidates: ['水怪', '睡乖', '税怪'],
  });
  assert.equal(await promise, true);

  const composed = events.filter((event) => event.kind === 'compose').map((event) => event.text);
  // 不是逐字打完就落字，而是整个词的拼音一口气连打。
  assert.deepEqual(composed, [
    's',
    'sh',
    'shu',
    'shui',
    "shui'g",
    "shui'gu",
    "shui'gua",
    "shui'guai",
    '',
  ]);

  // 搜索框只在最后出现一次完整词，中途不写半截字。
  const values = events.filter((event) => event.kind === 'value').map((event) => event.value);
  assert.deepEqual(values, ['水怪']);

  const candidates = events.filter((event) => event.kind === 'candidates');
  // 打字过程中给当前音节的候选字，拼音打完后换成候选词。
  assert.deepEqual(candidates[0].items, ['水', '睡']);
  assert.deepEqual(candidates[1].items, ['怪', '乖']);
  assert.deepEqual(candidates.at(-1).items, ['水怪', '睡乖', '税怪']);
  assert.deepEqual(
    candidates.map((event) => event.active),
    candidates.map(() => 0),
  );

  assert.equal(events.at(-1).kind, 'hide');
});

test('候选词缺省时退化为只展示目标词', async () => {
  const { events, promise } = run('代码', ['dai', 'ma'], {
    charCandidatesFor: (_syllable, char) => [char],
  });
  assert.equal(await promise, true);
  const candidates = events.filter((event) => event.kind === 'candidates');
  assert.deepEqual(candidates.at(-1).items, ['代码']);
  assert.deepEqual(
    events.filter((event) => event.kind === 'compose').map((event) => event.text),
    ['d', 'da', 'dai', "dai'm", "dai'ma", ''],
  );
  assert.deepEqual(
    events.filter((event) => event.kind === 'value').map((event) => event.value),
    ['代码'],
  );
});

test('缺少拼音数据时只落字，不弹输入法面板', async () => {
  const { events, promise } = run('水怪', []);
  assert.equal(await promise, true);
  assert.equal(events.some((event) => event.kind === 'compose'), false);
  assert.equal(events.some((event) => event.kind === 'candidates'), false);
  assert.deepEqual(
    events.filter((event) => event.kind === 'value').map((event) => event.value),
    ['水怪'],
  );
  assert.equal(events.at(-1).kind, 'hide');
});

test('英文/数字没有输入法，直接落字', async () => {
  const { events, promise } = run('astro代码', ['a', 's', 't', 'r', 'o', 'dai', 'ma']);
  assert.equal(await promise, true);
  assert.equal(events.some((event) => event.kind === 'compose'), false);
  assert.deepEqual(
    events.filter((event) => event.kind === 'value').map((event) => event.value),
    ['astro代码'],
  );
});

test('减少动态效果：直接写入完整词并收起面板', async () => {
  const { events, promise } = run('水怪', ['shui', 'guai'], { reduceMotion: true });
  assert.equal(await promise, true);
  assert.deepEqual(events, [{ kind: 'value', value: '水怪' }, { kind: 'hide' }]);
});

test('单音节词也能整词落字', async () => {
  const { events, promise } = run('鱼', ['yu'], { charCandidatesFor: (_syllable, char) => [char] });
  assert.equal(await promise, true);
  assert.deepEqual(
    events.filter((event) => event.kind === 'compose').map((event) => event.text),
    ['y', 'yu', ''],
  );
  assert.deepEqual(
    events.filter((event) => event.kind === 'value').map((event) => event.value),
    ['鱼'],
  );
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
