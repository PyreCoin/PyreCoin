// ─── BUY SECTION ─────────────────────────────────────────────────────
// Inline-mounts Jupiter Plugin — Jupiter's canonical 2025+ embed
// product (successor to the now-broken Terminal v3, which hardcoded
// retired API endpoints like tokens.jup.ag / quote-api.jup.ag /
// api.jup.ag/price/v2). Plugin uses Jupiter Ultra under the hood and
// self-resolves token metadata / quotes / swap routes via the current
// api.jup.ag endpoints, so it survives Jupiter's API migrations without
// a code change on our side.
//
// Lazy-mount via IntersectionObserver: the Plugin bundle is heavy and
// not every visitor scrolls to the buy section. We wait until #buy
// enters the viewport, then load + init once. Subsequent re-entries
// are no-ops (the _initialized flag short-circuits).
//
// We deliberately keep wallet handling separate from the burn flow:
// Plugin carries its own Wallet Standard adapter and a Connect Wallet
// button inside the widget (enableWalletPassthrough: false, the
// default). This avoids two competing wallet-state machines (burn.js's
// and Plugin's) fighting over which is "active." Users can connect a
// different wallet to buy than they used to burn, which is fine —
// neither flow shares state.
//
// pyrecoin.com never custodies or touches funds at any point — the
// widget signs and broadcasts directly to the user's wallet and
// Jupiter's contracts. We're just hosting the iframe-equivalent.

import { PYRE_MINT_STR, isPlaceholder } from './config.js';
import { $ } from './utils.js';

// Wrapped SOL — Plugin expects mint addresses, not symbols. "So111…
// 1112" is the wSOL mint that Jupiter normalises bare SOL to for
// routing purposes.
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Jupiter Plugin v1 bundle — the active embed product as of 2026-05.
// See developers.jup.ag/docs/tool-kits/plugin. Self-mounts into a
// target element when configured with displayMode: 'integrated'.
// If this URL changes upstream the widget will fail to load and we
// fall back to the "Open on jup.ag" link below.
const JUPITER_PLUGIN_SRC = 'https://plugin.jup.ag/plugin-v1.js';

// One-time script loader. Avoids re-injecting the bundle if the modal
// gets opened multiple times in one session. Returns the same Promise
// for concurrent calls so racing the loader between rapid re-opens
// doesn't duplicate the network request.
let _jupScriptPromise = null;
function loadJupiterScript() {
  if (window.Jupiter) return Promise.resolve();
  if (_jupScriptPromise) return _jupScriptPromise;
  _jupScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = JUPITER_PLUGIN_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      _jupScriptPromise = null;
      reject(new Error('Jupiter Plugin failed to load — CDN unreachable'));
    };
    document.head.appendChild(s);
  });
  return _jupScriptPromise;
}

let _jupInitialized = false;
function initJupiter() {
  if (_jupInitialized) return;
  if (!window.Jupiter) throw new Error('window.Jupiter not present after load');
  window.Jupiter.init({
    // 'integrated' mounts the swap UI into our existing target div.
    // 'modal' would give the Plugin its own backdrop (conflicts with
    // our modal); 'widget' is a floating button (not what we want).
    displayMode: 'integrated',
    integratedTargetId: 'jupiter-target',
    // Plugin handles RPC via Ultra internally — passing `endpoint`
    // would override that with our own, but our worker's Origin
    // allowlist + 60-req/min/IP rate limit would throttle the widget.
    // Letting Ultra manage RPC keeps the widget independent of our
    // Helius free-tier quota AND keeps the Burn-vs-Buy flows from
    // competing for the same RPC budget.
    formProps: {
      initialOutputMint: PYRE_MINT_STR,
      initialInputMint: SOL_MINT,
      // Lock the output to $PYRE so users can't accidentally swap
      // INTO some other token from this modal. Input stays flexible
      // (SOL by default but users with USDC etc. can change it).
      fixedOutputMint: true,
      fixedInputMint: false,
      swapMode: 'ExactIn',
    },
    defaultExplorer: 'Solscan',
    // Plugin's internal wallet flow — Connect Wallet button inside
    // the widget. enableWalletPassthrough:false is the default; we
    // could pipe our burn-side Wallet Standard adapter through with
    // true, but keeping them separate is the cleaner UX for now.
    branding: {
      logoUri: 'https://pyrecoin.com/official_coin_image.png',
      name: '$PYRE',
    },
  });
  _jupInitialized = true;
}

function showFallback(message) {
  const t = $('jupiter-target');
  if (!t) return;
  t.innerHTML =
    '<div style="padding:24px;text-align:center;color:var(--text2);' +
    'font-family:\'DM Mono\',monospace;font-size:12px;line-height:1.7;">' +
    '<p>' + message + '</p>' +
    '<p style="margin-top:14px;">' +
    '<a href="https://jup.ag/tokens/' + PYRE_MINT_STR + '" ' +
    'target="_blank" rel="noopener noreferrer" ' +
    'style="color:var(--ember2);text-decoration:underline;">' +
    'Open on jup.ag ↗</a>' +
    '</p></div>';
}

// The Plugin renders its own "Powered by Jupiter" attribution strip
// at the bottom of the widget. Combined with our section-intro
// "...routed via Jupiter, Solana's aggregator..." copy that's right
// above it, this reads as duplicate branding. We hide the internal
// strip via DOM scan after render — class names inside the Plugin's
// React tree are not stable across releases, so we match by text
// content (the only reliable signal).
// Recursively walk a node's children AND any shadowRoots so we can
// reach Plugin internals if they're rendered in a closed shadow tree.
// Yields every descendant Element across DOM and shadow boundaries.
function* walkDeep(node) {
  if (!node) return;
  if (node.shadowRoot) {
    for (const child of node.shadowRoot.children) {
      yield child;
      yield* walkDeep(child);
    }
  }
  if (node.children) {
    for (const child of node.children) {
      yield child;
      yield* walkDeep(child);
    }
  }
}

function hideInternalAttribution() {
  // Search the whole document body — Plugin renders into a shadow
  // root attached to a div in body, NOT into our #jupiter-target.
  // walkDeep crosses the shadow boundary. The actual strip is a
  // <span> whose textContent (with inner-flex <a>) collapses to
  // "powered byjupiter" — NO space between 'by' and 'Jupiter',
  // because the inline child element doesn't introduce whitespace.
  // So we match 'powered' AND 'jupiter' separately, not the phrase.
  let foundAny = false;
  for (const el of walkDeep(document.body)) {
    if (el.dataset && el.dataset.pyreHidden === '1') continue;
    const t = (el.textContent || '').replace(/\s+/g, '').toLowerCase();
    // Require both tokens AND a short total length so we don't match
    // the whole widget (whose textContent contains both words plus
    // a lot more).
    if (t.length > 0 && t.length < 40 && t.includes('poweredby') && t.includes('jupiter')) {
      // Walk up to the largest ancestor whose normalised text is STILL
      // just the attribution strip (i.e. doesn't bleed into siblings).
      let target = el;
      while (target.parentElement) {
        const pt = (target.parentElement.textContent || '').replace(/\s+/g, '').toLowerCase();
        if (pt.length < 40 && pt.includes('poweredby') && pt.includes('jupiter')) {
          target = target.parentElement;
        } else {
          break;
        }
      }
      target.style.setProperty('display', 'none', 'important');
      if (target.dataset) target.dataset.pyreHidden = '1';
      foundAny = true;
    }
  }
  return foundAny;
}

function startAttributionWatcher() {
  // The Plugin's React mount staggers across multiple frames — we
  // run the hider on a schedule (immediate, 250ms, 800ms, 2s, 4s),
  // AND attach a MutationObserver, so any of the rendering paths
  // catches the strip. Idempotent because we mark hidden elements
  // with data-pyre-hidden=1 above.
  const tries = () => { hideInternalAttribution(); };
  tries();
  [250, 800, 2000, 4000].forEach(d => setTimeout(tries, d));

  const root = $('jupiter-target');
  if (!root) return;
  const obs = new MutationObserver(tries);
  obs.observe(root, { childList: true, subtree: true });
  // Give up after 8s — if Plugin hasn't rendered by then the user has
  // bigger problems than an extra "Powered by" line.
  setTimeout(() => obs.disconnect(), 8000);
}

// Single-shot mount. Calling this multiple times is safe — the
// internal flags short-circuit duplicates. Returns a Promise that
// resolves when the widget is initialised (or shows a fallback on
// failure).
let _mountStarted = false;
async function mountBuyWidget(){
  if (_mountStarted) return;
  _mountStarted = true;

  if (isPlaceholder()) {
    showFallback('$PYRE has not launched yet. The buy widget activates once the token mint is configured.');
    return;
  }

  try {
    await loadJupiterScript();
    initJupiter();
    startAttributionWatcher();
  } catch (err) {
    // Fallback link to jup.ag covers the case where the Plugin CDN is
    // blocked (corp networks, ad blockers misclassifying it, etc.).
    _mountStarted = false; // allow retry on next observer fire
    showFallback('Couldn\'t load the embedded widget. ' + (err.message || ''));
  }
}

// Lazy-mount on first scroll into view. The Plugin bundle is sizeable;
// not every visitor scrolls to the buy section, so we don't pay the
// cost up-front. rootMargin: '200px 0px' starts loading just before the
// section enters the viewport so the widget is ready by the time the
// user actually sees it.
function startLazyMount(){
  const target = document.getElementById('buy');
  if (!target) return;
  // Fallback for ancient browsers w/o IntersectionObserver — just mount
  // immediately. Modern browsers (>99% of traffic) take the lazy path.
  if (typeof IntersectionObserver !== 'function') {
    mountBuyWidget();
    return;
  }
  const obs = new IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        observer.disconnect();
        mountBuyWidget();
        break;
      }
    }
  }, { rootMargin: '200px 0px', threshold: 0 });
  obs.observe(target);
}

// Anchor-jump to #buy should also force a mount in case the user lands
// directly on the section (where the IntersectionObserver may have
// already fired on initial paint, but timing is implementation-defined
// and we don't want a blank slot if it didn't). Listening to hashchange
// covers both initial load with #buy in URL and click-jumps from the
// nav.
function maybeMountFromHash(){
  if (location.hash === '#buy') mountBuyWidget();
}
window.addEventListener('hashchange', maybeMountFromHash);

// Kick off the lazy mount + handle the initial-load case.
startLazyMount();
maybeMountFromHash();
