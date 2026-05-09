// STATS — derived strictly from on-chain ingest output. Never reads
// the demo ENTRIES in leaderboard.js (those are dev-only reference data
// that must never reach the live page — fabricated burn totals would be
// CFTC Rule 180.1 / FTC §5 territory per project-policy §1).
//
// Pre-launch (placeholder mint): zeros.
// Post-launch with no leaderboard.json yet (fresh after the mainnet flip,
//   or fetch failed): zeros — same as the empty-state leaderboard renders.
// Post-launch with real ingest data: compute from the live JSON only.

import { isPlaceholder } from './config.js';
import { $, fmt } from './utils.js';

function entryBurnSum(entry){
  return (entry.burns || []).reduce((a, b) => a + (b.amount || 0), 0);
}

async function fetchLiveEntries(){
  try {
    const res = await fetch('./leaderboard.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = await res.json();
    return (data && Array.isArray(data.entries)) ? data.entries : [];
  } catch (_) {
    return [];
  }
}

export async function updateStats(){
  // Price + market cap require a DEX feed. Until that's wired up, both
  // stay '—' regardless of mint state — never showing fabricated values.
  $('s-price').textContent = '—';
  $('s-mcap').textContent  = '—';

  if (isPlaceholder()) {
    $('s-burned').textContent  = '0';
    $('s-holders').textContent = '0';
    return;
  }

  const entries = await fetchLiveEntries();
  const total   = entries.reduce((a, e) => a + entryBurnSum(e), 0);
  const burners = new Set(entries.map(e => e.wallet)).size;
  $('s-burned').textContent  = fmt(total);
  $('s-holders').textContent = burners.toLocaleString();
}
