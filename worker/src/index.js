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
