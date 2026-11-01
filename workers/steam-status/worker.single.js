// Cloudflare Dashboard 单文件版（不装 wrangler 时用这个）
//
// 用法：Workers & Pages → Create → Worker → Edit code，把本文件全部粘进去，Deploy。
// 然后在 Settings → Variables and Secrets 里加两个 Secret（不是明文变量）：
//   STEAM_API_KEY = https://steamcommunity.com/dev/apikey 申请的 key
//   STEAM_ID      = 76561198311103824
// 最后 Settings → Domains & Routes → Add route：moxo.cc/api/steam-status（zone: moxo.cc）。
//
// 这份是 src/index.js + src/shape.js 的合并版，逻辑完全一样；
// 改了 src/ 之后记得同步这里，否则两版会漂。

const UPSTREAM = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
const CACHE_SECONDS = 45;
const ERROR_CACHE_SECONDS = 10;
const TIMEOUT_MS = 4000;
const ALLOWED_ORIGINS = new Set(['https://moxo.cc', 'https://www.moxo.cc']);

const PERSONA_STATES = ['offline', 'online', 'busy', 'away', 'snooze', 'trade', 'play'];
const PUBLIC_VISIBILITY = 3;

function shapePlayer(player, now = Date.now()) {
  if (!player || typeof player !== 'object') {
    return { state: 'unknown', updatedAt: now };
  }

  const visible = Number(player.communityvisibilitystate) === PUBLIC_VISIBILITY;
  const game = typeof player.gameextrainfo === 'string' && player.gameextrainfo.trim() ? player.gameextrainfo.trim() : null;

  let state;
  if (!visible) {
    state = 'private';
  } else if (game) {
    state = 'in-game';
  } else {
    const index = Number(player.personastate);
    state = Number.isInteger(index) && PERSONA_STATES[index] ? PERSONA_STATES[index] : 'unknown';
  }

  const lastLogoff = Number(player.lastlogoff);

  return {
    state,
    game,
    name: typeof player.personaname === 'string' ? player.personaname : null,
    avatar: typeof player.avatarfull === 'string' ? player.avatarfull : null,
    lastLogoff: Number.isFinite(lastLogoff) && lastLogoff > 0 ? lastLogoff * 1000 : null,
    updatedAt: now,
  };
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    Vary: 'Origin',
  };
}

function json(body, { status = 200, seconds = CACHE_SECONDS, request, extra = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=30, s-maxage=${seconds}, stale-while-revalidate=120`,
      ...corsHeaders(request),
      ...extra,
    },
  });
}

async function readStatus(env) {
  if (!env.STEAM_API_KEY || !env.STEAM_ID) {
    return { ok: false, reason: 'missing_secret', body: { state: 'unknown', updatedAt: Date.now() } };
  }

  const target = `${UPSTREAM}?key=${encodeURIComponent(env.STEAM_API_KEY)}&steamids=${encodeURIComponent(env.STEAM_ID)}`;

  try {
    const upstream = await fetch(target, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cf: { cacheTtl: 40, cacheEverything: true },
    });

    if (!upstream.ok) {
      return { ok: false, reason: `upstream_${upstream.status}`, body: { state: 'unknown', updatedAt: Date.now() } };
    }

    const data = await upstream.json();
    const player = data?.response?.players?.[0] ?? null;
    return { ok: true, body: shapePlayer(player, Date.now()) };
  } catch (error) {
    const reason = error?.name === 'TimeoutError' ? 'timeout' : 'fetch_failed';
    return { ok: false, reason, body: { state: 'unknown', updatedAt: Date.now() } };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname !== '/api/steam-status') {
      return new Response('Not Found', { status: 404 });
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ state: 'unknown', error: 'method_not_allowed' }, { status: 405, request, seconds: 0 });
    }

    const cacheKey = new Request(`${url.origin}/api/steam-status`, { method: 'GET' });
    const cache = caches.default;

    const hit = await cache.match(cacheKey);
    if (hit) return new Response(request.method === 'HEAD' ? null : hit.body, hit);

    const result = await readStatus(env);
    const response = json(result.body, {
      status: 200,
      seconds: result.ok ? CACHE_SECONDS : ERROR_CACHE_SECONDS,
      request,
      extra: { 'X-Steam-Status': result.ok ? 'ok' : result.reason },
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
