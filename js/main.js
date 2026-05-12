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

const V = '20260512-32';

// Bootstrap stub for submitBurn only — defined SYNCHRONOUSLY before any
// await so an inline form-submit fired before burn.js finishes loading
// is a no-op instead of a crash. burn.js overwrites this on load. The
// modal open/close stubs are gone because the forms are now inline and
// reached via anchor jumps, not function calls.
window.submitBurn = function(){};

// Top-level module loads with cache-busting. await is module-top-level,
// supported in all browsers that support ES modules.
await import(`./fire-shader.js?v=${V}`);
const { refreshEntries, refreshInscriptions } = await import(`./data.js?v=${V}`);
const lb = await import(`./leaderboard.js?v=${V}`);
const { renderLeaderboard } = lb;
const { renderInscriptionWall } = await import(`./inscription-wall.js?v=${V}`);
const { updateStats } = await import(`./stats.js?v=${V}`);
const { PYRE_MINT_STR } = await import(`./config.js?v=${V}`);
const { parseEmoji } = await import(`./utils.js?v=${V}`);

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
  // Inline write form's "min burn to take #1" tip — tied to the live
  // leaderboard, so re-compute on the same cadence as the board itself.
  // Optional chaining handles the load-order race where main.js ticks
  // once before burn.js finishes its dynamic import.
  window.refreshBurnHint?.();
  // CTA "burn ~$X to take #1" line — same cadence, no new fetch (uses
  // cached PYRE/USD price + freshly-rendered entries).
  window.__pyreRenderCtaPrices?.();
  // Mirror the visitor count card into the CTA. stats.js wrote #s-vis7d
  // a microtask ago (updateStats is awaited above), so the value is
  // ready to read.
  renderViewerCount();
}

// Initial render + steady cadence. Heat visibly decays between ticks
// because renderLeaderboard takes wall-clock `now` as input even when
// the underlying entries are unchanged.
tick();
setInterval(tick, 30000);

// One-shot Twemoji parse of every static emoji on the page (CTA
// viewer-count line eyes/finger, footer ornaments, etc.). The
// leaderboard + inscription wall renderers parse their own containers
// after each tick — those don't depend on this one-shot.
//
// twemoji.min.js loads with `defer`, so it may not be on window at
// module-load time. Poll briefly (≤5s) then give up — if the CDN is
// blocked / down, the page degrades to native emoji.
function bootEmojiParse(remaining = 50){
  if (window.twemoji) { parseEmoji(document.body); return; }
  if (remaining <= 0) return;
  setTimeout(() => bootEmojiParse(remaining - 1), 100);
}
bootEmojiParse();

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
const FIRE_SECTIONS = ['write', 'buy', 'math', 'metrics', 'etymology', 'rules'];
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

// ── SMART NAV ── hide nav when scrolling down, reveal on scroll up.
// Above the threshold the nav stays visible; the threshold avoids the
// jitter that comes from elastic-scroll/momentum at the top of the page.
(function smartNav(){
  const nav = document.querySelector('nav');
  if (!nav) return;
  const THRESHOLD = 80;
  const DELTA = 6; // ignore micro-scrolls
  let lastY = window.scrollY;
  let ticking = false;
  function update(){
    const y = window.scrollY;
    const diff = y - lastY;
    if (y < THRESHOLD){
      nav.classList.remove('nav--hidden');
    } else if (diff > DELTA){
      nav.classList.add('nav--hidden');
    } else if (diff < -DELTA){
      nav.classList.remove('nav--hidden');
    }
    lastY = y;
    ticking = false;
  }
  window.addEventListener('scroll', () => {
    if (!ticking){
      requestAnimationFrame(update);
      ticking = true;
    }
  }, { passive: true });
})();

// ── LIVE PRICES in the top CTA ──────────────────────────────────
// Two readouts, both live, both pulled from one Jupiter Price V3 call:
//
//   1. SOL cost per inscription: base fee + priority fee + 1-lamport
//      beacon transfer = INSCRIPTION_FEE_LAMPORTS × SOL/USD.
//   2. USD-to-take-#1: minBurnToTakeTop() (in $PYRE) × PYRE/USD.
//      Re-rendered as the leaderboard refreshes, so the number tracks
//      the live heat. Inscription is free — the burn-to-#1 line is the
//      optional, additive layer.
//
// Refreshes on 60s timer AND inside the main tick() loop after each
// leaderboard refresh, so the #1 figure stays current.
const { SOL_MINT_STR, JUP, INSCRIPTION_FEE_LAMPORTS } = await import(`./config.js?v=${V}`);
const { fmtUsd } = await import(`./utils.js?v=${V}`);
const PRICE_URL = `${JUP.PRICE}?ids=${SOL_MINT_STR},${PYRE_MINT_STR}`;
let _solUsd = null;
let _pyreUsd = null;
async function refreshPrices(){
  try {
    const res = await fetch(PRICE_URL, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const s = data?.[SOL_MINT_STR]?.usdPrice;
    const p = data?.[PYRE_MINT_STR]?.usdPrice;
    if (typeof s === 'number' && isFinite(s) && s > 0) _solUsd = s;
    if (typeof p === 'number' && isFinite(p) && p > 0) _pyreUsd = p;
    renderCtaPrices();
  } catch (_) { /* keep last good values */ }
}
function renderCtaPrices(){
  const costEl = document.getElementById('cta-cost');
  if (costEl && _solUsd != null) {
    costEl.textContent = fmtUsd((INSCRIPTION_FEE_LAMPORTS / 1e9) * _solUsd);
  }
  const topEl = document.getElementById('cta-top-spot');
  if (topEl && _pyreUsd != null && lb?.minBurnToTakeTop) {
    // Bare-minimum buy-and-burn cost to take #1 on the leaderboard.
    // ONLY the swap+burn of the $PYRE amount needed to clear the
    // current top heat. No Solana network fee (gas), no service fee,
    // no extra-$PYRE-to-wallet add-on — just the buy-and-burn.
    const pyreAmount = lb.minBurnToTakeTop(Date.now());
    topEl.textContent = fmtUsd(pyreAmount * _pyreUsd);
  }
}

// Wire the visitor-count stat card → CTA social-proof line.
//
// Speed: the Worker → CF Analytics fetch in stats.js takes ~1–2s on
// cold load. To avoid the user seeing "brand new" for a couple of
// seconds before the real number arrives on every visit, we cache
// the last-known good value in localStorage with a ~6h TTL. On page
// load:
//   1. Sync (microseconds): read cache and paint immediately — no
//      network call, no waiting for the Worker.
//   2. Async: when stats.js writes a real number into #s-vis7d, the
//      30s tick() calls renderViewerCount which updates the display
//      AND refreshes the cache.
//
// Net effect: returning visitors see a real number instantly. Brand-
// new visitors with no cache see the "brand new" fallback until the
// first Worker fetch resolves.
const VIEWER_CACHE_KEY = 'pyre.viewerCount';
const VIEWER_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
function isRealCount(txt) {
  return !!txt && txt !== '—' && txt !== '0' && txt !== '~0';
}
function loadCachedViewerCount() {
  try {
    const raw = localStorage.getItem(VIEWER_CACHE_KEY);
    if (!raw) return null;
    const { value, ts } = JSON.parse(raw);
    if (!isRealCount(value)) return null;
    if (typeof ts !== 'number' || Date.now() - ts > VIEWER_CACHE_TTL_MS) return null;
    return value;
  } catch { return null; }
}
function saveCachedViewerCount(value) {
  try {
    localStorage.setItem(VIEWER_CACHE_KEY, JSON.stringify({ value, ts: Date.now() }));
  } catch {}
}
function renderViewerCount(){
  const src = document.getElementById('s-vis7d');
  const line = document.getElementById('cta-viewers-line');
  const dst = document.getElementById('cta-viewers');
  if (!src || !line || !dst) return;
  const txt = (src.textContent || '').trim();
  if (isRealCount(txt)) {
    dst.textContent = txt;
    saveCachedViewerCount(txt);
  } else {
    // No real data from the worker yet — fall back to the cached
    // last-known good value if it's fresh; otherwise show "brand new".
    const cached = loadCachedViewerCount();
    dst.textContent = cached || 'brand new';
  }
  line.hidden = false;
}
// Sync paint at bootstrap: if a cached value exists, render the line
// immediately so users don't see anything missing while stats.js's
// fetch is in flight. Subsequent tick()s refresh via renderViewerCount.
(function instantViewerPaint(){
  const cached = loadCachedViewerCount();
  if (!cached) return;
  const line = document.getElementById('cta-viewers-line');
  const dst  = document.getElementById('cta-viewers');
  if (line && dst) { dst.textContent = cached; line.hidden = false; }
})();
refreshPrices();
setInterval(refreshPrices, 60_000);
// Expose so tick() can re-render the #1 figure after each lb refresh
// without re-fetching prices.
window.__pyreRenderCtaPrices = renderCtaPrices;

// ── TITLE FITTER ─────────────────────────────────────────────────
// The typewriter cycles words of widely varying widths ("hopes" vs
// "shower thoughts" vs "protest signs"). At narrow viewports (≤320px)
// the longest words overflow and wrap onto a second line, which
// breaks the layout for the next sub-line. We measure every candidate
// word against the title's available width and scale the title's
// font-size down just enough that the WIDEST word still fits on one
// physical line at the current viewport. Runs after fonts load and
// on resize/orientationchange. Linear scale = one-shot answer, no
// search loop.
function fitTitleToContainer(){
  const title = document.querySelector('.top-cta-title');
  const wordEl = document.getElementById('typed-word');
  if (!title || !wordEl) return;
  // Reset any prior inline override so we measure against the CSS-
  // derived starting size.
  title.style.fontSize = '';
  const cs = getComputedStyle(title);
  const startSize = parseFloat(cs.fontSize);
  if (!isFinite(startSize) || startSize <= 0) return;
  const availWidth = title.clientWidth;
  if (availWidth <= 0) return;
  const probe = document.createElement('span');
  probe.style.cssText =
    'position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;top:-9999px;' +
    `font:${cs.font};letter-spacing:${cs.letterSpacing};` +
    `text-transform:${cs.textTransform};font-feature-settings:${cs.fontFeatureSettings};`;
  document.body.appendChild(probe);
  let maxWidth = 0;
  for (const w of TYPED_WORDS) {
    probe.textContent = 'Burn your ' + w + '|';
    if (probe.offsetWidth > maxWidth) maxWidth = probe.offsetWidth;
  }
  probe.remove();
  if (maxWidth <= 0 || maxWidth <= availWidth) return;
  const targetSize = Math.max(14, Math.floor(startSize * (availWidth / maxWidth)));
  title.style.fontSize = targetSize + 'px';
}
let _fitDebounce = null;
function scheduleFit(){
  clearTimeout(_fitDebounce);
  _fitDebounce = setTimeout(fitTitleToContainer, 100);
}
if (document.fonts?.ready) document.fonts.ready.then(fitTitleToContainer);
else fitTitleToContainer();
window.addEventListener('resize', scheduleFit, { passive: true });
window.addEventListener('orientationchange', scheduleFit, { passive: true });

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
