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

const V = '20260511-17';

// Bootstrap stubs — defined SYNCHRONOUSLY before any await so HTML
// inline onclick handlers never call undefined functions while modules
// load. burn.js overwrites these on load.
function _bootstrapOpen(){
  document.getElementById('burnModal').classList.add('open');
  document.body.style.overflow = 'hidden';
  const ws = document.getElementById('walletStatus');
  if (ws) ws.innerHTML = '<span style="color:var(--text2)">loading wallet libraries…</span>';
}
window.openWriteModal    = _bootstrapOpen;
window.openInscribeModal = _bootstrapOpen;
window.openBurnModal     = _bootstrapOpen;
window.closeBurnModal = function(){
  document.getElementById('burnModal').classList.remove('open');
  document.body.style.overflow = '';
};
window.submitBurn = function(){};

// Top-level module loads with cache-busting. await is module-top-level,
// supported in all browsers that support ES modules.
await import(`./fire-shader.js?v=${V}`);
const { refreshEntries, refreshInscriptions } = await import(`./data.js?v=${V}`);
const lb = await import(`./leaderboard.js?v=${V}`);
const { renderLeaderboard } = lb;
const { renderInscriptionWall } = await import(`./inscription-wall.js?v=${V}`);
const { updateStats } = await import(`./stats.js?v=${V}`);

// Expose the leaderboard module so burn.js can read minBurnToTakeTop
// without re-importing the module under a different specifier (which
// would create a second module instance with its own state).
window.__pyreLeaderboard = lb;

// Single tick: refresh the shared entries cache once, then run both
// renderers off the same snapshot. Previously each renderer fetched
// leaderboard.json independently and only stats.js refreshed on the
// 30s interval — the leaderboard itself never updated post-load.
async function tick() {
  // Both files in parallel — independent endpoints.
  await Promise.all([refreshEntries(), refreshInscriptions()]);
  const now = new Date();
  renderLeaderboard(now);
  renderInscriptionWall(now);
  updateStats();
}

// Initial render + steady cadence. Heat visibly decays between ticks
// because renderLeaderboard takes wall-clock `now` as input even when
// the underlying entries are unchanged.
tick();
setInterval(tick, 30000);

// Lazy-load burn module — defers heavy Solana lib download. Versioned
// so post-launch fixes propagate without a hard refresh.
import(`./burn.js?v=${V}`);

// Lazy-load buy module — same versioning. The Jupiter Plugin bundle
// itself is only fetched when the user actually opens the Buy modal,
// so this import is cheap (just the small wiring layer).
import(`./buy.js?v=${V}`);

// ── NAV LINKS ON FIRE ────────────────────────────────────────────
// As the user scrolls, the nav anchor link matching the section
// currently in the active band gets `.is-on-fire` — visually the
// fire transfers from the pyre (behind the sticky nav) to the link
// itself. Sections without a corresponding nav link are ignored.
//
// rootMargin: '-80px 0px -55% 0px' means a section "ignites" once
// its top crosses 80px from the viewport top (just under the nav)
// and "extinguishes" once the section scrolls past the lower 45%
// band. Net effect: only one section is on fire at a time, and the
// transition feels like the flame passing from one link to the
// next as you scroll.
const FIRE_SECTIONS = ['how', 'metrics', 'etymology', 'rules'];
const fireObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const link = document.querySelector(`.nav-links a[href="#${entry.target.id}"]`);
    if (!link) return;
    if (entry.isIntersecting) {
      link.classList.add('is-on-fire');
    } else {
      link.classList.remove('is-on-fire');
    }
  });
}, {
  rootMargin: '-80px 0px -55% 0px',
  threshold: 0,
});
FIRE_SECTIONS.forEach(id => {
  const el = document.getElementById(id);
  if (el) fireObserver.observe(el);
});

// ── TYPEWRITER in the top CTA headline ───────────────────────────
// "Burn your ____ into the blockchain." — cycles a noun in the blank
// with a blinking cursor. Order shuffled per page-load so repeat
// visitors don't always see the same opener. Words are deliberately
// cultural / personal — no investment-sounding "alpha", "signals",
// "calls", etc. (compliance §1: digital-collectible framing).
const TYPED_WORDS = [
  'dreams', 'hopes', 'fears', 'love letters', 'regrets',
  'secrets', 'confessions', 'manifestos', 'prayers',
  'shower thoughts', 'bad jokes', 'shitposts', 'vendettas',
  'protest signs', 'last words',
];
function runTypewriter(){
  const el = document.getElementById('typed-word');
  if (!el) return;
  let wordIdx = Math.floor(Math.random() * TYPED_WORDS.length);
  let letterIdx = 0;
  let mode = 'typing'; // typing | pausing | erasing
  function step(){
    const word = TYPED_WORDS[wordIdx];
    if (mode === 'typing'){
      letterIdx++;
      el.textContent = word.slice(0, letterIdx);
      if (letterIdx >= word.length){ mode = 'pausing'; setTimeout(step, 1800); return; }
      setTimeout(step, 70 + Math.random() * 60);
    } else if (mode === 'pausing'){
      mode = 'erasing';
      setTimeout(step, 80);
    } else {
      letterIdx--;
      el.textContent = word.slice(0, letterIdx);
      if (letterIdx <= 0){
        wordIdx = (wordIdx + 1) % TYPED_WORDS.length;
        mode = 'typing';
        setTimeout(step, 280);
        return;
      }
      setTimeout(step, 35);
    }
  }
  step();
}
runTypewriter();
