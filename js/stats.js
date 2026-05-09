// STATS — derived strictly from on-chain ingest output and a live
// Jupiter price feed. Never reads demo data; all displayed numbers
// must trace to a real source. Pre-launch (placeholder mint) → all
// zeros. Post-launch with no leaderboard.json yet → zeros for
// burned/burners. Jupiter API failure → '—' for price/mcap.
//
// Refresh cadence: main.js calls updateStats() on load and every 30s.

import { isPlaceholder, PYRE_MINT_STR, RPC_URL } from './config.js';
import { $, fmt } from './utils.js';

// Total supply is read fresh from chain on every refresh. Burns through
// pyrecoin.com use Token-2022 BurnChecked, which permanently reduces
// the on-chain supply, so the value moves over the lifetime of an open
// page session. Caching it for the session (the previous behavior)
// would freeze mcap and "circulating" against an outdated value as
// soon as anyone — including the viewer — burned. getTokenSupply is
// one cheap RPC call per 30s tick; a freshness leak here is more
// expensive than the call. Pre-launch (placeholder mint) we never
// reach the fetch.

// Jupiter Price API V3 (lite-api / free tier). Browser-side fetch with
// CORS allowed. Returns a usdPrice that's been outlier-filtered against
// reliable oracle anchors (SOL price), so it's stable enough to render
// directly without further smoothing.
const JUP_PRICE_URL = 'https://lite-api.jup.ag/price/v3?ids=';

function entryBurnSum(entry){
  return (entry.burns || []).reduce((a, b) => a + (b.amount || 0), 0);
}

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
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenSupply',
        params: [mint],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ui = data?.result?.value?.uiAmount;
    if (typeof ui === 'number' && isFinite(ui) && ui > 0) return ui;
    return null;
  } catch (_) { return null; }
}

async function fetchJupPrice(mint){
  try {
    const res = await fetch(JUP_PRICE_URL + encodeURIComponent(mint), { cache: 'no-store' });
    if (!res.ok) return { price: null, change24h: null };
    const data = await res.json();
    const row = data?.[mint] || {};
    const p = row.usdPrice;
    const c = row.priceChange24h;
    return {
      price: (typeof p === 'number' && isFinite(p) && p > 0) ? p : null,
      change24h: (typeof c === 'number' && isFinite(c)) ? c : null,
    };
  } catch (_) { return { price: null, change24h: null }; }
}

function fmtChange(c){
  if (c == null) return { text: '', cls: '' };
  const arrow = c >= 0 ? '▲' : '▼';
  const cls = c >= 0 ? 'up' : 'down';
  return { text: `${arrow} ${Math.abs(c).toFixed(1)}% 24h`, cls };
}

function fmtPrice(p){
  if (p == null) return '—';
  // Memecoin prices are usually fractions of a cent. Keep enough sig
  // figs to distinguish a 5x without scientific notation.
  if (p < 1e-6) return '$' + p.toExponential(2);
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

export async function updateStats(){
  if (isPlaceholder()) {
    $('s-burned').textContent  = '0';
    $('s-burners').textContent = '0';
    $('s-price').textContent   = '—';
    $('s-mcap').textContent    = '—';
    setChange($('s-price-change'), null);
    return;
  }

  // Three independent fetches in parallel. Token supply is cached after
  // the first successful fetch (it doesn't change), so steady-state cost
  // is leaderboard.json (local, ~10ms) + Jupiter (~200-500ms).
  const [entries, jup, supply] = await Promise.all([
    fetchLiveEntries(),
    fetchJupPrice(PYRE_MINT_STR),
    fetchTokenSupply(PYRE_MINT_STR),
  ]);

  const total   = entries.reduce((a, e) => a + entryBurnSum(e), 0);
  const burners = new Set(entries.map(e => e.wallet)).size;

  $('s-burned').textContent  = fmt(total);
  $('s-burners').textContent = burners.toLocaleString();
  $('s-price').textContent   = fmtPrice(jup.price);
  setChange($('s-price-change'), jup.change24h);
  // Standard mcap (price × full supply) for parity with how jup.ag
  // and pump.fun display it. Supply is fetched from chain (not
  // hardcoded) so we never fabricate the mcap if pump.fun ever
  // changes their supply default. If either price or supply lookup
  // fails, the stat falls back to '—' rather than guessing.
  const mcapNum = (jup.price != null && supply != null) ? jup.price * supply : null;
  $('s-mcap').textContent    = mcapNum == null ? '—' : fmtMcap(mcapNum);
}
