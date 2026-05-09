// Entry point. Wires modules together and kicks off rendering.
//
// burn.js is loaded via dynamic import() so its Solana lib deps
// (~500KB combined from esm.sh) don't block the fire-shader, leaderboard,
// or stats rendering. Pre-stubs below keep the page interactive during
// that brief load window.

import './fire-shader.js';
import { renderLeaderboard, NOW_REF } from './leaderboard.js';
import { updateStats } from './stats.js';

// Bootstrap stubs so HTML inline onclick="openBurnModal()" / form onsubmit
// never call undefined functions while burn.js is still downloading.
// burn.js overwrites all three on load.
window.openBurnModal = function(){
  document.getElementById('burnModal').classList.add('open');
  document.body.style.overflow = 'hidden';
  const ws = document.getElementById('walletStatus');
  if (ws) ws.innerHTML = 'Wallet: <span style="color:var(--text2)">loading wallet libraries…</span>';
};
window.closeBurnModal = function(){
  document.getElementById('burnModal').classList.remove('open');
  document.body.style.overflow = '';
};
window.submitBurn = function(){};

// Initial render of stats + leaderboard.
updateStats();
renderLeaderboard(NOW_REF);

// Re-rank periodically so heat visibly decays while the page is open.
// updateStats() also re-fetches leaderboard.json so totals + burner
// count refresh as new burns ingest (no-op while placeholder, and a
// no-op-equivalent while the JSON is 404 / empty — both yield zero).
const PAGE_LOAD_T = Date.now();
setInterval(() => {
  const simulated = new Date(NOW_REF.getTime() + (Date.now() - PAGE_LOAD_T));
  renderLeaderboard(simulated);
  updateStats();
}, 30000);

// Lazy-load burn module — defers heavy Solana lib download.
import('./burn.js');
