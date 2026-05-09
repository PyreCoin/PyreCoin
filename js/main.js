// Entry point. Wires modules together and kicks off rendering.
//
// CACHE-BUSTING: GitHub Pages serves JS with Cache-Control: max-age=600
// (10-minute browser cache, no ETag-only revalidation). Without
// versioned URLs, returning users see stale JS for up to 10 minutes
// after a deploy. We learned this the hard way during the launch flip
// when a stats bug stayed visible to anyone whose browser had cached
// the previous build.
//
// To force returning visitors onto fresh code, this file uses dynamic
// import() with a version query string, and the <script> tag in
// index.html that loads main.js carries the same version. Bump V on
// every deploy that touches user-visible JS — even one character is
// enough to invalidate every browser's cached copy. The version
// also rides through to burn.js (lazy-loaded) and the top-level
// modules below.
//
// Transitive imports (e.g. config.js, utils.js imported by stats.js)
// are NOT versioned here — they're stable utility files that almost
// never change. If you do change them, bump V and force-bust them
// inside their importer too.

const V = '20260509-2';

// Bootstrap stubs — defined SYNCHRONOUSLY before any await so HTML
// inline onclick="openBurnModal()" / form onsubmit never call
// undefined functions while modules load. burn.js overwrites all
// three on load.
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

// Top-level module loads with cache-busting. await is module-top-level,
// supported in all browsers that support ES modules.
await import(`./fire-shader.js?v=${V}`);
const { renderLeaderboard, NOW_REF } = await import(`./leaderboard.js?v=${V}`);
const { updateStats } = await import(`./stats.js?v=${V}`);

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

// Lazy-load burn module — defers heavy Solana lib download. Versioned
// so post-launch fixes propagate without a hard refresh.
import(`./burn.js?v=${V}`);
