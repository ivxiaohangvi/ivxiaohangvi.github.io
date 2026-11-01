// GET /api/steam-status → { state, game, name, avatar, lastLogoff, updatedAt }
//
// 为什么要在 Worker 里绕一圈：Steam 的 Web API 不返回 CORS 头（OPTIONS 直接 405），
// 浏览器直连会被拦；key 也不能进前端。Worker 同源返回，顺手缓存 45 秒，
// 把调用量压到每天两千次以内。

import { shapePlayer } from './shape.js';

const UPSTREAM = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/';
const CACHE_SECONDS = 45;
const ERROR_CACHE_SECONDS = 10;
const TIMEOUT_MS = 4000;

// 主站和 www 都放行；同源请求其实用不到这个头，留着方便以后在别处嵌卡片
const ALLOWED_ORIGINS = new Set(['https://moxo.cc', 'https://www.moxo.cc']);

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

    // 缓存键固定成不带查询串的规范 URL，避免 ?t=xxx 之类把缓存打散
    const cacheKey = new Request(`${url.origin}/api/steam-status`, { method: 'GET' });
    const cache = caches.default;

    const hit = await cache.match(cacheKey);
    if (hit) return new Response(request.method === 'HEAD' ? null : hit.body, hit);

    const result = await readStatus(env);
    const response = json(result.body, {
      status: result.ok ? 200 : 200,
      seconds: result.ok ? CACHE_SECONDS : ERROR_CACHE_SECONDS,
      request,
      extra: { 'X-Steam-Status': result.ok ? 'ok' : result.reason },
    });

    // 失败也缓存 10 秒：避免 Steam 抖动时把每个访客都变成一次上游请求
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

async function readStatus(env) {
  if (!env.STEAM_API_KEY || !env.STEAM_ID) {
    return { ok: false, reason: 'missing_secret', body: { state: 'unknown', updatedAt: Date.now() } };
  }

  const target = `${UPSTREAM}?key=${encodeURIComponent(env.STEAM_API_KEY)}&steamids=${encodeURIComponent(env.STEAM_ID)}`;

  try {
    const upstream = await fetch(target, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // 上游自己也有边缘缓存，40 秒内同一区域只回源一次
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
