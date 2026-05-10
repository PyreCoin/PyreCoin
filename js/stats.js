// Owns the entire "BY THE NUMBERS" section — the eight stat cards and
// (via big-charts.js) the four big chart panels beneath them.
//
// Data sources:
//   - leaderboard.json    (committed by the ingest cron — every burn,
//                          its amount, ts, wallet, message)
//   - getTokenSupply RPC  (current on-chain supply, via the worker)
//   - Jupiter Price V3    (current spot price, free, no key)
//   - /price-history      (worker → GeckoTerminal hourly OHLCV)
//   - /analytics          (worker → CF GraphQL Web Analytics)
//
// Numbers must trace to a real source. Pre-launch (placeholder mint),
// every card renders zeros / dashes — see the early-return below.
//
// Refresh cadence: main.js calls updateStats() on load and every 30s.
// The worker caches /price-history and /analytics for 5 min, so most
// 30s ticks are local cache hits and don't reach Helius / Gecko / CF.

import { isPlaceholder, INITIAL_SUPPLY, PYRE_MINT_STR, RPC_URL } from './config.js';
import { $, fmt } from './utils.js';

// charts.js + big-charts.js are dynamic-imported with the same `?v=`
// version that this module was loaded under. Per CLAUDE.md §7.1: any
// non-stable utility file we import needs to participate in the
// cache-bust chain, otherwise GitHub Pages's 10-min max-age leaves
// returning visitors on a stale chart renderer after a deploy. We
// extract V from import.meta.url so we don't have to duplicate the
// constant from main.js into every consumer.
const V = (() => {
  try { return new URL(import.meta.url).searchParams.get('v') || ''; }
  catch (_) { return ''; }
})();
const _chartsMod    = await import(`./charts.js?v=${V}`);
const _bigChartsMod = await import(`./big-charts.js?v=${V}`);
const { sparkline }       = _chartsMod;
const { renderBigCharts } = _bigChartsMod;

const JUP_PRICE_URL  = 'https://lite-api.jup.ag/price/v3?ids=';
// The worker's public origin. Same host as RPC_URL but rewritten to
// our two new GET endpoints. RPC_URL is `https://rpc.pyrecoin.com/`
// in prod and pointed at a placeholder pre-launch — we resolve the
// origin from it so dev/test environments work transparently.
function workerOrigin() {
  try { return new URL(RPC_URL).origin; }
  catch (_) { return ''; }
}

const HOUR_MS = 3_600_000;
const DAY_MS  = 24 * HOUR_MS;
const WINDOW_HOURS = 240;             // 10 days × 24h
const WINDOW_DAYS  = 10;

// ── fetchers ─────────────────────────────────────────────────────

async function fetchLiveEntries(){
  try {
    const res = await fetch('./leaderboard.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = await res.json();
    return (data && Array.isArray(data.entries)) ? data.entries : [];
  } catch (_) { return []; }
}

async function fetchTokenSupply(mint){
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenSupply', params: [mint] }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ui = data?.result?.value?.uiAmount;
    return (typeof ui === 'number' && isFinite(ui) && ui > 0) ? ui : null;
  } catch (_) { return null; }
}

async function fetchJupPrice(mint){
  try {
    const res = await fetch(JUP_PRICE_URL + encodeURIComponent(mint), { cache: 'no-store' });
    if (!res.ok) return { price: null, change24h: null };
    const data = await res.json();
    const row = data?.[mint] || {};
    const p = row.usdPrice, c = row.priceChange24h;
    return {
      price:     (typeof p === 'number' && isFinite(p) && p > 0) ? p : null,
      change24h: (typeof c === 'number' && isFinite(c)) ? c : null,
    };
  } catch (_) { return { price: null, change24h: null }; }
}

async function fetchPriceHistory(){
  const origin = workerOrigin();
  if (!origin) return null;
  try {
    const res = await fetch(`${origin}/price-history?hours=${WINDOW_HOURS}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    // Expected shape: { ohlcv: [[tsSeconds, o, h, l, c, vol], ...] }
    return Array.isArray(data?.ohlcv) ? data.ohlcv : null;
  } catch (_) { return null; }
}

async function fetchAnalytics(){
  const origin = workerOrigin();
  if (!origin) return null;
  try {
    const res = await fetch(`${origin}/analytics?hours=${WINDOW_HOURS}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    // Expected shape: { hourlyVisits: [{tsSeconds, count}, ...], topCountries: [{label, value}, ...] }
    return {
      hourlyVisits: Array.isArray(data?.hourlyVisits) ? data.hourlyVisits : [],
      topCountries: Array.isArray(data?.topCountries) ? data.topCountries : [],
    };
  } catch (_) { return null; }
}

// ── derivations ──────────────────────────────────────────────────
// Bucket an entries[] array (from leaderboard.json) into hourly burn
// volumes for the past WINDOW_HOURS. Returns oldest → newest.

function hourlyBurnVolume(entries, nowMs){
  const buckets = new Array(WINDOW_HOURS).fill(0);
  const startMs = nowMs - WINDOW_HOURS * HOUR_MS;
  for (const e of entries) {
    const ts = Date.parse(e.ts);
    if (!isFinite(ts) || ts < startMs || ts > nowMs) continue;
    const idx = Math.min(WINDOW_HOURS - 1, Math.floor((ts - startMs) / HOUR_MS));
    if (typeof e.amount === 'number' && isFinite(e.amount)) {
      buckets[idx] += e.amount;
    }
  }
  return buckets;
}

// Daily-bucketed view, oldest → newest. Used for sparklines under the
// burn-volume / avg-burn-size cards.
function dailyBurnVolume(entries, nowMs){
  const days = WINDOW_DAYS;
  const buckets = new Array(days).fill(0);
  const startMs = nowMs - days * DAY_MS;
  for (const e of entries) {
    const ts = Date.parse(e.ts);
    if (!isFinite(ts) || ts < startMs || ts > nowMs) continue;
    const idx = Math.min(days - 1, Math.floor((ts - startMs) / DAY_MS));
    if (typeof e.amount === 'number' && isFinite(e.amount)) {
      buckets[idx] += e.amount;
    }
  }
  return buckets;
}

// Daily count of burns (used to derive "avg burn size per day" series).
function dailyBurnCount(entries, nowMs){
  const days = WINDOW_DAYS;
  const buckets = new Array(days).fill(0);
  const startMs = nowMs - days * DAY_MS;
  for (const e of entries) {
    const ts = Date.parse(e.ts);
    if (!isFinite(ts) || ts < startMs || ts > nowMs) continue;
    const idx = Math.min(days - 1, Math.floor((ts - startMs) / DAY_MS));
    buckets[idx] += 1;
  }
  return buckets;
}

// Cumulative-burned series — the running total of $PYRE burned over
// time. Sorted by ts ascending, then carried forward over 10 daily
// buckets. The final value matches s-burned (modulo on-chain supply
// drift, which is tiny). Used as the sparkline for the "$PYRE Burned"
// card.
function cumulativeBurnedDaily(entries, nowMs){
  const sorted = entries.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const days = WINDOW_DAYS;
  const buckets = new Array(days).fill(null);
  const startMs = nowMs - days * DAY_MS;
  // Running total of burns up to the start of the window — anything
  // older still counts toward "cumulative" in the first bucket.
  let running = 0;
  for (const e of sorted) {
    if (Date.parse(e.ts) < startMs) {
      running += (typeof e.amount === 'number' && isFinite(e.amount)) ? e.amount : 0;
    }
  }
  let i = 0;
  for (const e of sorted) {
    const ts = Date.parse(e.ts);
    if (!isFinite(ts) || ts < startMs) continue;
    while (i < days && (startMs + (i + 1) * DAY_MS) <= ts) {
      buckets[i] = running;
      i += 1;
    }
    running += (typeof e.amount === 'number' && isFinite(e.amount)) ? e.amount : 0;
  }
  while (i < days) { buckets[i] = running; i += 1; }
  return buckets;
}

// Cumulative unique-burner-count series — running total of distinct
// wallets seen up to each of WINDOW_DAYS daily buckets.
function cumulativeBurnersDaily(entries, nowMs){
  const sorted = entries.slice().sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const days = WINDOW_DAYS;
  const buckets = new Array(days).fill(null);
  const startMs = nowMs - days * DAY_MS;
  const seen = new Set();
  for (const e of sorted) {
    if (Date.parse(e.ts) < startMs) seen.add(e.wallet);
  }
  let i = 0;
  for (const e of sorted) {
    const ts = Date.parse(e.ts);
    if (!isFinite(ts) || ts < startMs) continue;
    while (i < days && (startMs + (i + 1) * DAY_MS) <= ts) {
      buckets[i] = seen.size;
      i += 1;
    }
    seen.add(e.wallet);
  }
  while (i < days) { buckets[i] = seen.size; i += 1; }
  return buckets;
}

// Hourly closes, oldest → newest, derived from the GeckoTerminal
// /price-history payload which arrives newest-first.
function hourlyClosesFromOhlcv(ohlcv, hours){
  if (!Array.isArray(ohlcv) || ohlcv.length === 0) return [];
  const ascending = ohlcv.slice().sort((a, b) => a[0] - b[0]); // oldest first
  const tail = ascending.slice(-hours);
  return tail.map(r => (typeof r[4] === 'number' && isFinite(r[4])) ? r[4] : null);
}

// Hourly visit counts, oldest → newest, padded to length `hours`. The
// analytics endpoint may return fewer hours if the beacon hasn't been
// running that long; we left-pad with nulls so the sparkline domain
// stays stable.
function hourlyVisitsBuckets(analytics, hours, nowMs){
  if (!analytics || !Array.isArray(analytics.hourlyVisits)) return new Array(hours).fill(null);
  const buckets = new Array(hours).fill(null);
  const startMs = Math.floor((nowMs - hours * HOUR_MS) / HOUR_MS) * HOUR_MS;
  for (const row of analytics.hourlyVisits) {
    const ts = (row.tsSeconds != null) ? row.tsSeconds * 1000 : NaN;
    if (!isFinite(ts) || ts < startMs) continue;
    const idx = Math.min(hours - 1, Math.floor((ts - startMs) / HOUR_MS));
    if (idx < 0) continue;
    const v = Number(row.count);
    if (isFinite(v)) buckets[idx] = (buckets[idx] || 0) + v;
  }
  return buckets;
}

// ── formatters (small) ───────────────────────────────────────────

function fmtChange(c){
  if (c == null) return { text: '', cls: '' };
  const arrow = c >= 0 ? '▲' : '▼';
  const cls   = c >= 0 ? 'up' : 'down';
  return { text: `${arrow} ${Math.abs(c).toFixed(1)}% 24h`, cls };
}

function fmtPrice(p){
  if (p == null) return '—';
  if (p < 1e-6)  return '$' + p.toExponential(2);
  if (p < 0.0001) return '$' + p.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  if (p < 1)      return '$' + p.toFixed(6);
  return '$' + p.toFixed(4);
}

function fmtMcap(m){
  if (m == null) return '—';
  if (m >= 1e9) return '$' + (m/1e9).toFixed(2) + 'B';
  if (m >= 1e6) return '$' + (m/1e6).toFixed(2) + 'M';
  if (m >= 1e3) return '$' + (m/1e3).toFixed(1) + 'K';
  return '$' + m.toFixed(2);
}

function setChange(el, c){
  if (!el) return;
  const { text, cls } = fmtChange(c);
  el.textContent = text;
  el.classList.remove('up', 'down');
  if (cls) el.classList.add(cls);
}

function clearAllSparks() {
  ['sp-price','sp-burned','sp-burners','sp-mcap',
   'sp-vol24','sp-avgburn','sp-vis24','sp-vis7d'].forEach(id => {
    const el = $(id); if (el) el.innerHTML = '';
  });
}

// ── main entrypoint ──────────────────────────────────────────────

export async function updateStats(){
  if (isPlaceholder()) {
    $('s-burned').textContent  = '0';
    $('s-burners').textContent = '0';
    $('s-price').textContent   = '—';
    $('s-mcap').textContent    = '—';
    $('s-vol24').textContent   = '0';
    $('s-avgburn').textContent = '—';
    $('s-vis24').textContent   = '—';
    $('s-vis7d').textContent   = '—';
    setChange($('s-price-change'), null);
    clearAllSparks();
    renderBigCharts({ priceHistory: null, analytics: null, hourlyBurns: null });
    return;
  }

  // Five independent fetches in parallel. The worker caches
  // /price-history and /analytics for 5 min, so most ticks resolve
  // these cheaply. leaderboard.json is in-repo and fast (~10ms).
  const [entries, jup, supply, priceHistory, analytics] = await Promise.all([
    fetchLiveEntries(),
    fetchJupPrice(PYRE_MINT_STR),
    fetchTokenSupply(PYRE_MINT_STR),
    fetchPriceHistory(),
    fetchAnalytics(),
  ]);

  const nowMs = Date.now();

  // ── headline numbers ──
  const burned  = (supply != null) ? Math.max(0, INITIAL_SUPPLY - supply) : null;
  const burners = new Set(entries.map(e => e.wallet)).size;

  $('s-burned').textContent  = burned == null ? '—' : fmt(burned);
  $('s-burners').textContent = burners.toLocaleString();
  $('s-price').textContent   = fmtPrice(jup.price);
  setChange($('s-price-change'), jup.change24h);
  const mcapNum = (jup.price != null && supply != null) ? jup.price * supply : null;
  $('s-mcap').textContent    = mcapNum == null ? '—' : fmtMcap(mcapNum);

  // 24h burn volume — sum entries with ts in last 24h.
  const cutoff24 = nowMs - DAY_MS;
  const last24 = entries.filter(e => Date.parse(e.ts) >= cutoff24);
  const vol24 = last24.reduce((s, e) => s + (typeof e.amount === 'number' ? e.amount : 0), 0);
  $('s-vol24').textContent = vol24 ? fmt(vol24) : '0';

  // Avg burn size over the full 10-day window. We use the window (not
  // 24h) so the average isn't whiplashed by a single big burn.
  const cutoffWindow = nowMs - WINDOW_DAYS * DAY_MS;
  const recent = entries.filter(e => Date.parse(e.ts) >= cutoffWindow && typeof e.amount === 'number');
  const avg = recent.length > 0 ? recent.reduce((s, e) => s + e.amount, 0) / recent.length : null;
  $('s-avgburn').textContent = (avg == null) ? '—' : fmt(Math.round(avg));

  // Visitors (today / 7d) come from the analytics buckets. If the
  // analytics endpoint is unconfigured or unreachable, both cards
  // show '—' rather than 0 — silence over false negative.
  if (analytics && Array.isArray(analytics.hourlyVisits) && analytics.hourlyVisits.length > 0) {
    const vis24Buckets = hourlyVisitsBuckets(analytics, 24, nowMs);
    const vis7dBuckets = hourlyVisitsBuckets(analytics, 168, nowMs);
    const sum = arr => arr.reduce((s, v) => s + (v || 0), 0);
    $('s-vis24').textContent = sum(vis24Buckets).toLocaleString();
    $('s-vis7d').textContent = sum(vis7dBuckets).toLocaleString();
  } else {
    $('s-vis24').textContent = '—';
    $('s-vis7d').textContent = '—';
  }

  // ── sparklines ──
  const cumBurned  = cumulativeBurnedDaily(entries, nowMs);
  const cumBurners = cumulativeBurnersDaily(entries, nowMs);
  const dailyVol   = dailyBurnVolume(entries, nowMs);
  const dailyCount = dailyBurnCount(entries, nowMs);
  const dailyAvg   = dailyVol.map((v, i) => dailyCount[i] > 0 ? v / dailyCount[i] : null);
  const hourlyVisits10d = hourlyVisitsBuckets(analytics, WINDOW_HOURS, nowMs);
  const hourlyBurns10d  = hourlyBurnVolume(entries, nowMs);

  // Price + mcap sparklines: 24h hourly closes (so the spark visibly
  // tracks price action over the last day). Mcap series uses the
  // current supply as the multiplier — burns don't generally move
  // supply enough in 24h to matter for the sparkline trend.
  const closes24h = hourlyClosesFromOhlcv(priceHistory, 24);
  const closes10d = hourlyClosesFromOhlcv(priceHistory, WINDOW_HOURS);
  const mcapSeries = (supply != null) ? closes24h.map(c => c == null ? null : c * supply) : closes24h;
  const priceTone = (jup.change24h == null) ? 'neutral' : (jup.change24h >= 0 ? 'up' : 'down');

  sparkline($('sp-price'),   closes24h,   { tone: priceTone });
  sparkline($('sp-mcap'),    mcapSeries,  { tone: priceTone });
  sparkline($('sp-burned'),  cumBurned);
  sparkline($('sp-burners'), cumBurners);
  sparkline($('sp-vol24'),   dailyVol);
  sparkline($('sp-avgburn'), dailyAvg);
  // Visitors sparklines: collapse hourly → daily for less noise.
  const vis24Hourly = hourlyVisitsBuckets(analytics, 24, nowMs);
  const vis10dDaily = bucketHourlyToDaily(hourlyVisits10d, WINDOW_DAYS);
  sparkline($('sp-vis24'), vis24Hourly);
  sparkline($('sp-vis7d'), vis10dDaily);

  // ── big charts ──
  renderBigCharts({
    priceHistory,                                  // raw OHLCV (newest-first)
    closes10d,                                     // for any future area-fill chart needs
    hourlyBurns: hourlyBurns10d,                   // 240 hourly buckets, oldest → newest
    hourlyVisits: hourlyVisits10d,                 // 240 hourly buckets, oldest → newest
    topCountries: analytics?.topCountries || [],
  });
}

// ── tiny util used only here ─────────────────────────────────────

// Collapse an hourly buckets array (length = hours) into daily buckets
// (length = days) by summing every 24 hours. Trailing partial day is
// dropped; we always report whole-day totals to keep the y-axis stable.
function bucketHourlyToDaily(hourly, days){
  const out = new Array(days).fill(null);
  if (!Array.isArray(hourly) || hourly.length === 0) return out;
  const need = days * 24;
  // Take the most-recent `need` hourly buckets (right-aligned).
  const tail = hourly.slice(-need);
  if (tail.length < need) return out;
  for (let d = 0; d < days; d++) {
    let s = 0, hadAny = false;
    for (let h = 0; h < 24; h++) {
      const v = tail[d * 24 + h];
      if (v != null) { s += v; hadAny = true; }
    }
    out[d] = hadAny ? s : null;
  }
  return out;
}
