import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifySteamSync,
  reconcileComments,
  syncStatus,
} from './lib/steam-sync.mjs';

const comment = (id, createdAt, name = id) => ({ id, createdAt, name });

test('完整抓取按实际数量判定正常', () => {
  assert.equal(classifySteamSync({ freshCount: 37, total: 37, complete: true }), 'ok');
  assert.equal(classifySteamSync({ freshCount: 50, total: 0, complete: true }), 'ok');
});

test('翻页中断、条数不足、没有数据分别判定', () => {
  assert.equal(classifySteamSync({ freshCount: 50, total: 80, complete: false }), 'partial');
  assert.equal(classifySteamSync({ freshCount: 37, total: 40, complete: true }), 'partial');
  assert.equal(classifySteamSync({ freshCount: 0, total: 40, complete: true }), 'failed');
  assert.equal(classifySteamSync({ freshCount: 0, total: 0, complete: false }), 'failed');
});

test('完整抓取时才把没出现的留言判为删除', () => {
  const previous = [
    comment('3', '2025-01-03T00:00:00Z', '旧三'),
    comment('2', '2025-01-02T00:00:00Z', '旧二'),
    comment('1', '2025-01-01T00:00:00Z', '旧一'),
  ];
  const fresh = [
    comment('4', '2025-01-04T00:00:00Z', '新四'),
    comment('2', '2025-01-02T00:00:00Z', '新二'),
  ];

  const ok = reconcileComments({
    fresh,
    previous,
    state: 'ok',
    now: '2025-02-01T00:00:00Z',
    previousSyncedAt: '2025-01-10T00:00:00Z',
  }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  assert.deepEqual(
    ok.map((item) => [item.id, item.name]),
    [
      ['4', '新四'],
      ['2', '新二'],
    ]
  );
  assert.equal(ok.every((item) => item.lastSeenAt === null), true);
});

test('不完整抓取时保留旧留言，并记住上次确认时间', () => {
  const previous = [
    { ...comment('3', '2025-01-03T00:00:00Z', '旧三'), lastSeenAt: null },
    { ...comment('2', '2025-01-02T00:00:00Z', '旧二'), lastSeenAt: '2025-01-05T00:00:00Z' },
  ];
  const fresh = [{ ...comment('4', '2025-01-04T00:00:00Z', '新四') }];

  const merged = reconcileComments({
    fresh,
    previous,
    state: 'partial',
    now: '2025-02-01T00:00:00Z',
    previousSyncedAt: '2025-01-20T00:00:00Z',
  });

  const byId = new Map(merged.map((item) => [item.id, item]));
  assert.equal(byId.get('4').lastSeenAt, null);
  // 旧快照里没记过 lastSeenAt 的，用上一轮的同步时间当作最后确认时间
  assert.equal(byId.get('3').lastSeenAt, '2025-01-20T00:00:00Z');
  // 已经记过的保持不动，反复 partial 不会每 6 小时改动一次快照
  assert.equal(byId.get('2').lastSeenAt, '2025-01-05T00:00:00Z');
});

test('旧快照不会被合并过程改写', () => {
  const previous = [comment('1', '2025-01-01T00:00:00Z', '旧')];
  const merged = reconcileComments({ fresh: [], previous, state: 'partial' });
  merged[0].name = '改过';
  assert.equal(previous[0].name, '旧');
});

test('空留言板是独立状态，不代表抓取失败', () => {
  assert.deepEqual(syncStatus('empty', 'empty'), { state: 'empty', reason: 'empty' });
  assert.deepEqual(syncStatus('ok'), { state: 'ok' });
  assert.deepEqual(syncStatus('failed', 'fetch'), { state: 'failed', reason: 'fetch' });
  assert.deepEqual(syncStatus('partial', 'incomplete'), {
    state: 'partial',
    reason: 'incomplete',
  });
  assert.throws(() => syncStatus('green'));
  assert.throws(() => syncStatus('failed', 'steam said no'));
});
