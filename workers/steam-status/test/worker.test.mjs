// 用 Node 模拟 Worker 运行时：验证 shapePlayer 的判定与 fetch handler 的缓存/降级。
import assert from 'node:assert/strict';
import { shapePlayer } from '../src/shape.js';

const player = (over = {}) => ({
  steamid: '76561198311103824',
  personaname: '背井离江的汤姆',
  communityvisibilitystate: 3,
  personastate: 1,
  lastlogoff: 1761700000,
  avatarfull: 'https://avatars.example/a_full.jpg',
  ...over,
});

// 1. shapePlayer
assert.equal(shapePlayer(player({ personastate: 0 })).state, 'offline');
assert.equal(shapePlayer(player({ personastate: 1 })).state, 'online');
assert.equal(shapePlayer(player({ personastate: 2 })).state, 'busy');
assert.equal(shapePlayer(player({ personastate: 3 })).state, 'away');
assert.equal(shapePlayer(player()) && shapePlayer(player()).lastLogoff, 1761700000000);

const gaming = shapePlayer(player({ personastate: 1, gameextrainfo: 'Apex Legends', gameid: '1172470' }));
assert.equal(gaming.state, 'in-game');
assert.equal(gaming.game, 'Apex Legends');

assert.equal(shapePlayer(player({ communityvisibilitystate: 1, personastate: 0 })).state, 'private');
assert.equal(shapePlayer(null).state, 'unknown');
assert.equal(shapePlayer(player({ personastate: 99 })).state, 'unknown');

// 2. fetch handler：缓存 + 降级
const store = new Map();
globalThis.caches = {
  default: {
    async match(req) {
      return store.get(req.url) ?? undefined;
    },
    async put(req, res) {
      store.set(req.url, res);
    },
  },
};

let upstreamCalls = 0;
globalThis.fetch = async (url) => {
  upstreamCalls += 1;
  if (String(url).includes('boom')) throw new Error('network');
  return new Response(
    JSON.stringify({ response: { players: [player({ personastate: 1, gameextrainfo: 'Apex Legends' })] } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
};

const { default: worker } = await import('../src/index.js');

const ctx = { waitUntil: (p) => p };
const env = { STEAM_API_KEY: 'k', STEAM_ID: '76561198311103824' };
const req = new Request('https://moxo.cc/api/steam-status');

const first = await worker.fetch(req, env, ctx);
const body = await first.json();
assert.equal(first.status, 200);
assert.equal(body.state, 'in-game');
assert.equal(body.game, 'Apex Legends');
assert.match(first.headers.get('Cache-Control'), /s-maxage=45/);
assert.equal(first.headers.get('X-Steam-Status'), 'ok');

const second = await worker.fetch(req, env, ctx);
assert.equal(second.status, 200);
assert.equal(upstreamCalls, 1, '第二次应命中缓存');

// 缺 secret → unknown，但仍 200，且缓存时间短（换 origin，避免命中上面的缓存）
const missing = await worker.fetch(new Request('https://nosecret.moxo.cc/api/steam-status'), {}, ctx);
const missingBody = await missing.json();
assert.equal(missingBody.state, 'unknown');
assert.equal(missing.headers.get('X-Steam-Status'), 'missing_secret');

// 上游失败 → unknown（换 origin，避免命中上面那份规范键缓存）
globalThis.fetch = async () => new Response('nope', { status: 500 });
const failed = await worker.fetch(new Request('https://fail.moxo.cc/api/steam-status'), env, ctx);
assert.equal((await failed.json()).state, 'unknown');
assert.equal(failed.headers.get('X-Steam-Status'), 'upstream_500');

// 非该路径 → 404
const other = await worker.fetch(new Request('https://moxo.cc/api/nope'), env, ctx);
assert.equal(other.status, 404);

console.log('steam-status worker: all assertions passed');

