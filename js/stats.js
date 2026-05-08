// STATS — derived from on-chain data; never fabricated. Pre-launch
// (placeholder mint) Total Burned and Burners are objectively 0. Price
// and Market Cap require a DEX feed and stay '—' until that is wired up.

import { isPlaceholder } from './config.js';
import { $, fmt } from './utils.js';
import { ENTRIES, totalBurned } from './leaderboard.js';

export function updateStats(){
  if (isPlaceholder()) {
    $('s-burned').textContent  = '0';
    $('s-holders').textContent = '0';
  } else {
    const totalAll = ENTRIES.reduce((a, e) => a + totalBurned(e), 0);
    const burners  = new Set(ENTRIES.map(e => e.wallet)).size;
    $('s-burned').textContent  = fmt(totalAll);
    $('s-holders').textContent = burners.toLocaleString();
  }
  $('s-price').textContent = '—';
  $('s-mcap').textContent  = '—';
}
