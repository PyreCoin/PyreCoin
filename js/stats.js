// STATS — derived strictly from on-chain ingest output and a live
// Jupiter price feed. Never reads demo data; all displayed numbers
// must trace to a real source. Pre-launch (placeholder mint) → all
// zeros. Post-launch with no leaderboard.json yet → zeros for
// burned/burners. Jupiter API failure → '—' for price/mcap.
//
// Refresh cadence: main.js calls updateStats() on load and every 30s.

import { isPlaceholder, PYRE_MINT_STR } from './config.js';
import { $, fmt } from './utils.js';

// pump.fun mints all tokens with a fixed 1B supply at 6 decimals. We
// hardcode this rather than fetching it from chain — it's a property
// of the platform that doesn't change for the lifetime of the token.
// If the token ever migrates off pump.fun infrastructure, revisit.
const TOTAL_SUPPLY = 1_000_000_000;

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
    $('s-holders').textContent = '0';
    $('s-price').textContent   = '—';
    $('s-mcap').textContent    = '—';
    setChange($('s-price-change'), null);
    return;
  }

  // Two independent fetches in parallel — neither blocks the other.
  // Jupiter is the slower of the two (external network, ~200-500ms);
  // leaderboard.json is local (10-20ms).
  const [entries, jup] = await Promise.all([
    fetchLiveEntries(),
    fetchJupPrice(PYRE_MINT_STR),
  ]);

  const total   = entries.reduce((a, e) => a + entryBurnSum(e), 0);
  const burners = new Set(entries.map(e => e.wallet)).size;

  $('s-burned').textContent  = fmt(total);
  $('s-holders').textContent = burners.toLocaleString();
  $('s-price').textContent   = fmtPrice(jup.price);
  setChange($('s-price-change'), jup.change24h);
  // Standard pump.fun-style mcap (price × full 1B supply) for parity
  // with what jup.ag and pump.fun show. The 'TOTAL BURNED' stat
  // separately surfaces the deflationary mechanic for anyone curious.
  $('s-mcap').textContent    = jup.price == null ? '—' : fmtMcap(jup.price * TOTAL_SUPPLY);
}
