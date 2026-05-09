// Cloudflare Worker — RPC proxy for pyrecoin.com.
//
// The browser-side burn modal needs to call Solana mainnet RPC
// (getAccountInfo on the user's PYRE token account, getLatestBlockhash,
// etc.). Solana Foundation's public mainnet endpoint started returning
// 403 to browser-origin calls in 2026-05; the only reliable free
// alternatives require an API key.
//
// This worker holds the Helius key in an encrypted env binding
// (HELIUS_KEY, set via `wrangler secret put`) and only proxies POSTs
// from allowlisted origins. Result: the key stays server-side, third
// parties scraping page source can't use the endpoint, and we keep
// the cron's Helius key (Key A) on its own quota.

const ALLOWED_ORIGINS = new Set([
  'https://pyrecoin.com',
  'https://www.pyrecoin.com',
  'https://pyrecoin.github.io',
]);

const HELIUS_BASE = 'https://mainnet.helius-rpc.com/?api-key=';

// ── PER-IP RATE LIMIT ─────────────────────────────────────────────
// The Origin allowlist above is enforced by browsers (CORS), but
// non-browser clients (curl, scripts) can spoof Origin headers
// freely. This rate limit is the actual abuse cap: caps requests per
// source IP so a harvested worker URL can't be used to drain Helius
// quota at any meaningful rate.
//
// In-memory map per worker instance. Cloudflare runs many independent
// instances across datacenters, so the effective ceiling is
// (RATE_LIMIT_MAX × instance count) per IP — but no single connection
// from one IP exceeds the per-instance cap, which is what matters.
//
// 60 req/min/IP gives a legitimate visitor headroom (~12 burn-modal
// opens per minute, where each open does ~5 RPC calls) while making
// scripted abuse impractical.

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
const ipBuckets = new Map();

function clientIp(request) {
  return request.headers.get('cf-connecting-ip') ||
         (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
         'unknown';
}

function rateLimitOk(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const bucket = (ipBuckets.get(ip) || []).filter(t => t > cutoff);
  bucket.push(now);
  ipBuckets.set(ip, bucket);
  // Bounded GC: when the map gets large, drop entries with no recent
  // activity. Cheap because most entries will be expired already.
  if (ipBuckets.size > 2000) {
    for (const [k, v] of ipBuckets) {
      if (v.every(t => t < cutoff)) ipBuckets.delete(k);
    }
  }
  return bucket.length <= RATE_LIMIT_MAX;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.has(origin);

    // CORS preflight. Only respond with allow-headers if origin is on
    // the allowlist; otherwise fail closed.
    if (request.method === 'OPTIONS') {
      if (!allowed) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!allowed) {
      return new Response(JSON.stringify({ error: 'forbidden origin' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (!env.HELIUS_KEY) {
      return new Response(JSON.stringify({ error: 'misconfigured: HELIUS_KEY not set' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const ip = clientIp(request);
    if (!rateLimitOk(ip)) {
      return new Response(JSON.stringify({ error: 'rate limited' }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
          ...corsHeaders(origin),
        },
      });
    }

    const body = await request.text();
    let upstream;
    try {
      upstream = await fetch(HELIUS_BASE + env.HELIUS_KEY, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'upstream fetch failed' }), {
        status: 502,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
      });
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(origin),
      },
    });
  },
};
