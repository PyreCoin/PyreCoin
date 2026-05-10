// Cloudflare Worker — three jobs:
//
//   1. POST /            → Solana RPC proxy (Helius), browser-only.
//   2. GET  /price-history → GeckoTerminal hourly OHLCV for the PYRE
//                            pool, cached 5 min via Cache API.
//   3. GET  /analytics   → Cloudflare GraphQL Web Analytics
//                          (hourly visits + top countries),
//                          cached 5 min via Cache API.
//
// Plus the existing scheduled handler that pokes GitHub
// workflow_dispatch every 5 min to drive the ingest cron.
//
// Why route everything through one worker instead of multiple:
//   - free-tier Workers cap at 100K req/day across the account
//     anyway, so one worker is no more expensive than three;
//   - the Origin allowlist + secret bindings live in one place;
//   - end users only see one third-party hostname (rpc.pyrecoin.com)
//     in network requests, which keeps the colophon honest.

const ALLOWED_ORIGINS = new Set([
  'https://pyrecoin.com',
  'https://www.pyrecoin.com',
  'https://pyrecoin.github.io',
]);

const HELIUS_BASE = 'https://mainnet.helius-rpc.com/?api-key=';

// Cache TTL for the GET endpoints. Both the GeckoTerminal API
// (30 req/min public limit) and the CF GraphQL Analytics API
// (similar low limit on the Free plan) appreciate this. With a
// 5-minute cache, even thousands of pageviews/hour resolve to ~12
// upstream calls/hour per endpoint.
const ENDPOINT_CACHE_TTL = 300;

// ── PER-IP RATE LIMIT ─────────────────────────────────────────────
// CORS gates browsers; rate limit gates everything else. 60 req/min/IP
// caps non-browser abuse without crowding legitimate visitors. The
// limit applies across all paths — a script flooding /price-history
// also burns from the same bucket as /rpc.

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(body, init = {}, origin = null) {
  const headers = new Headers(init.headers || {});
  headers.set('Content-Type', 'application/json');
  if (origin) {
    for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  }
  return new Response(JSON.stringify(body), { status: init.status || 200, headers });
}

// Apply CORS headers to a previously-built (or cached) Response. We
// do this at serve time rather than baking CORS into the cached body
// so a cache hit from one allowlisted origin doesn't poison the
// cached entry for a different allowlisted origin.
function withCors(response, origin) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}

// ── PRICE HISTORY (GeckoTerminal) ────────────────────────────────
// Hourly OHLCV for the PYRE/SOL pool on pump-fun. The pool address
// is stable for the life of the token but kept in env (PYRE_POOL,
// declared in wrangler.toml [vars]) so we can swap it without a code
// change if pump.fun ever migrates the pool to PumpSwap/Raydium.

async function fetchGeckoTerminalOhlcv(env) {
  const pool = env.PYRE_POOL || '6qtLrqwJu132JtMWTRzVymZJPkczbifzN9ejq4Lg5u2P';
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pool}/ohlcv/hour?aggregate=1&limit=240&currency=usd`;
  const r = await fetch(url, {
    headers: { 'Accept': 'application/json;version=20230302' },
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`geckoterminal ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  const rows = data?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) {
    throw new Error('geckoterminal: no ohlcv_list in response');
  }
  // Pass through verbatim: [tsSeconds, open, high, low, close, vol_usd].
  // The frontend tolerates either order; GT returns newest-first.
  return { ohlcv: rows, source: 'geckoterminal', pool };
}

async function handlePriceHistory(request, env, ctx, origin) {
  const cache = caches.default;
  // Cache key is method + URL; the URL already encodes any query
  // params (e.g. ?hours=240) so different ranges cache separately.
  const cacheKey = new Request(request.url, { method: 'GET' });
  let response = await cache.match(cacheKey);
  if (response) {
    return withCors(response, origin);
  }
  let payload;
  try {
    payload = await fetchGeckoTerminalOhlcv(env);
  } catch (err) {
    return jsonResponse({ error: 'price-history upstream failed', detail: err.message }, { status: 502 }, origin);
  }
  response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, s-maxage=${ENDPOINT_CACHE_TTL}, max-age=${ENDPOINT_CACHE_TTL}`,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return withCors(response, origin);
}

// ── ANALYTICS (CF GraphQL Web Analytics) ─────────────────────────
// Single GraphQL query with two aliased datasets:
//   - `hourly`    → 240 hourly visit-count buckets
//   - `countries` → top 50 countries by visit count
//
// Returns an empty payload with note='not configured' if the env vars
// aren't set yet. The frontend renders an empty-state placeholder in
// that case rather than failing hard.

const CF_GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

// Multiple siteTags supported via siteTag_in array filter. CF can
// generate distinct siteTags across a site's lifecycle (e.g.
// auto-inject phase → manual snippet phase produces a different
// internal id), so we accept a comma-separated CF_SITE_TAG env var
// and union them. The visible site in the dashboard is the same
// site, the data is just bucketed under the active id at ingest
// time.
const ANALYTICS_QUERY = `
query GetAnalytics($accountTag: String!, $siteTags: [String!]!, $datetimeStart: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      hourly: rumPageloadEventsAdaptiveGroups(
        limit: 240
        filter: { siteTag_in: $siteTags, datetime_geq: $datetimeStart }
        orderBy: [datetimeHour_DESC]
      ) {
        count
        dimensions {
          datetimeHour
        }
      }
      countries: rumPageloadEventsAdaptiveGroups(
        limit: 50
        filter: { siteTag_in: $siteTags, datetime_geq: $datetimeStart }
        orderBy: [count_DESC]
      ) {
        count
        dimensions {
          countryName
        }
      }
    }
  }
}
`;

async function fetchCfAnalytics(env, debug = false) {
  const token = env.CF_ANALYTICS_TOKEN;
  const accountTag = env.CF_ACCOUNT_ID;
  const siteTag = env.CF_SITE_TAG;
  if (!token || !accountTag || !siteTag) {
    return {
      hourlyVisits: [],
      topCountries: [],
      note: 'CF_ANALYTICS_TOKEN / CF_ACCOUNT_ID / CF_SITE_TAG not set; analytics will appear once configured',
    };
  }
  const datetimeStart = new Date(Date.now() - 240 * 3_600_000).toISOString();
  // Split on commas/whitespace, drop empties — supports both single
  // and multi-siteTag configurations transparently.
  const siteTags = siteTag.split(/[,\s]+/).map(s => s.trim()).filter(Boolean);
  const r = await fetch(CF_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: ANALYTICS_QUERY,
      variables: { accountTag, siteTags, datetimeStart },
    }),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`cf graphql ${r.status}: ${txt.slice(0, 300)}`);
  }
  const json = await r.json();
  // Always log the raw response so `npx wrangler tail` shows what CF
  // came back with — easiest way to spot field-name mismatches when
  // the dashboard has data but the page reads empty.
  console.log('cf graphql response:', JSON.stringify(json).slice(0, 1500));
  if (Array.isArray(json.errors) && json.errors.length) {
    // Surface the first error message — usually a permission scope
    // issue (token missing Account.Account Analytics: Read) or an
    // invalid siteTag.
    throw new Error(`cf graphql errors: ${json.errors[0]?.message || 'unknown'}`);
  }
  const acct = json?.data?.viewer?.accounts?.[0];
  const hourlyRaw = acct?.hourly || [];
  const countriesRaw = acct?.countries || [];

  // Debug mode: include the raw GraphQL response and the variables
  // we sent so the caller can inspect exactly what CF returned and
  // what we asked for. Used to diagnose siteTag / field-name issues
  // when the dashboard has data but the parsed payload is empty.
  if (debug) {
    // Discovery query: same dataset, NO siteTag filter, group by
    // siteTag in the dimensions. Reveals every siteTag that actually
    // has data in the account — directly comparable to whatever's
    // currently set as CF_SITE_TAG. If they don't match, that's the
    // bug.
    const discoveryQuery = `
query DiscoverSites($accountTag: String!, $datetimeStart: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      sites: rumPageloadEventsAdaptiveGroups(
        limit: 50
        filter: { datetime_geq: $datetimeStart }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { siteTag }
      }
      withPath: rumPageloadEventsAdaptiveGroups(
        limit: 80
        filter: { datetime_geq: $datetimeStart }
        orderBy: [count_DESC]
      ) {
        count
        dimensions { siteTag, requestPath }
      }
    }
  }
}`;
    const dr = await fetch(CF_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: discoveryQuery, variables: { accountTag, datetimeStart } }),
    });
    let discoveryRaw = null;
    try { discoveryRaw = await dr.json(); } catch (_) { discoveryRaw = { _error: 'discovery parse failed' }; }
    return {
      hourlyVisits: hourlyRaw.map(g => ({
        tsSeconds: Math.floor(Date.parse(g?.dimensions?.datetimeHour) / 1000),
        count: g?.count || 0,
      })),
      topCountries: countriesRaw.map(g => ({
        label: g?.dimensions?.countryName || 'Unknown',
        value: g?.count || 0,
      })),
      _debug: {
        sentVariables: { accountTag, siteTags, datetimeStart },
        sentQuery: ANALYTICS_QUERY,
        rawResponse: json,
        hourlyRowCount: hourlyRaw.length,
        countriesRowCount: countriesRaw.length,
        discovery: discoveryRaw,
        howToCompare: 'Compare _debug.sentVariables.siteTags (what we sent) vs _debug.discovery.data.viewer.accounts[0].sites[*].dimensions.siteTag (what CF has data for). Any siteTag in discovery that is NOT in sentVariables is data we are missing.',
      },
    };
  }
  return {
    hourlyVisits: hourlyRaw.map(g => ({
      tsSeconds: Math.floor(Date.parse(g?.dimensions?.datetimeHour) / 1000),
      count: g?.count || 0,
    })).filter(e => isFinite(e.tsSeconds)),
    topCountries: countriesRaw.map(g => ({
      label: g?.dimensions?.countryName || 'Unknown',
      value: g?.count || 0,
    })).filter(e => e.value > 0),
  };
}

async function handleAnalytics(request, env, ctx, origin) {
  const url = new URL(request.url);
  // ?debug=1 bypasses the 5-min cache and returns the raw CF GraphQL
  // response so we can inspect what's actually coming back when the
  // dashboard has data but the parsed payload reads empty.
  const debug = url.searchParams.get('debug') === '1';
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: 'GET' });

  if (!debug) {
    const cached = await cache.match(cacheKey);
    if (cached) return withCors(cached, origin);
  }
  let payload;
  try {
    payload = await fetchCfAnalytics(env, debug);
  } catch (err) {
    return jsonResponse({ error: 'analytics upstream failed', detail: err.message }, { status: 502 }, origin);
  }
  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': debug
        ? 'no-store'
        : `public, s-maxage=${ENDPOINT_CACHE_TTL}, max-age=${ENDPOINT_CACHE_TTL}`,
    },
  });
  if (!debug) ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return withCors(response, origin);
}

// ── INGEST CRON TRIGGER (unchanged from prior version) ───────────

const INGEST_REPO = 'PyreCoin/PyreCoin';
const INGEST_WORKFLOW = 'ingest.yml';

async function dispatchIngest(env) {
  if (!env.GITHUB_PAT) {
    console.error('GITHUB_PAT not set; skipping ingest dispatch');
    return;
  }
  try {
    const r = await fetch(
      `https://api.github.com/repos/${INGEST_REPO}/actions/workflows/${INGEST_WORKFLOW}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.GITHUB_PAT}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'pyre-cron-trigger',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error(`ingest dispatch ${r.status}: ${body}`);
    }
  } catch (err) {
    console.error(`ingest dispatch threw: ${err.message}`);
  }
}

// ── MAIN ENTRY ───────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.has(origin);
    const url = new URL(request.url);

    // CORS preflight. Origin allowlist is enforced even on preflight
    // — a non-allowlisted page can't even discover what methods the
    // worker accepts.
    if (request.method === 'OPTIONS') {
      if (!allowed) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!allowed) {
      return jsonResponse({ error: 'forbidden origin' }, { status: 403 });
    }

    const ip = clientIp(request);
    if (!rateLimitOk(ip)) {
      return jsonResponse({ error: 'rate limited' }, {
        status: 429,
        headers: { 'Retry-After': '60' },
      }, origin);
    }

    if (request.method === 'GET') {
      if (url.pathname === '/price-history') {
        return handlePriceHistory(request, env, ctx, origin);
      }
      if (url.pathname === '/analytics') {
        return handleAnalytics(request, env, ctx, origin);
      }
      return jsonResponse({ error: 'not found' }, { status: 404 }, origin);
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Default POST behavior = Helius RPC proxy.
    if (!env.HELIUS_KEY) {
      return jsonResponse({ error: 'misconfigured: HELIUS_KEY not set' }, { status: 500 }, origin);
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
      return jsonResponse({ error: 'upstream fetch failed' }, { status: 502 }, origin);
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

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(dispatchIngest(env));
  },
};
