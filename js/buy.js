// ─── BUY BUTTON ─────────────────────────────────────────────────────
// Embeds Jupiter Plugin — Jupiter's canonical 2025+ embed product
// (successor to the now-broken Terminal v3, which hardcoded retired
// API endpoints like tokens.jup.ag / quote-api.jup.ag / api.jup.ag/
// price/v2). Plugin uses Jupiter Ultra under the hood and self-resolves
// token metadata / quotes / swap routes via the current api.jup.ag
// endpoints, so it survives Jupiter's API migrations without a code
// change on our side.
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

window.openBuyModal = async function openBuyModal() {
  const modal = $('buyModal');
  if (!modal) return;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';

  if (isPlaceholder()) {
    showFallback('$PYRE has not launched yet. The buy widget activates once the token mint is configured.');
    return;
  }

  try {
    await loadJupiterScript();
    initJupiter();
  } catch (err) {
    showFallback('Couldn\'t load the embedded widget. ' + (err.message || ''));
  }
};

window.closeBuyModal = function closeBuyModal() {
  const modal = $('buyModal');
  if (!modal) return;
  modal.classList.remove('open');
  document.body.style.overflow = '';
};

// Click-outside-to-close — same pointer-down + pointer-up pattern as
// burn.js so a drag-select that ends outside the modal doesn't trip
// a close.
(function wireBackdropDismiss() {
  const backdrop = $('buyModal');
  if (!backdrop) return;
  let pointerDownOnBackdrop = false;
  backdrop.addEventListener('pointerdown', (e) => {
    pointerDownOnBackdrop = (e.target === backdrop);
  });
  backdrop.addEventListener('pointerup', (e) => {
    if (pointerDownOnBackdrop && e.target === backdrop) {
      window.closeBuyModal();
    }
    pointerDownOnBackdrop = false;
  });
  backdrop.addEventListener('pointercancel', () => { pointerDownOnBackdrop = false; });
})();

// Escape-to-close.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('buyModal')?.classList.contains('open')) {
    window.closeBuyModal();
  }
});

// Deep-link: pyrecoin.com/?openBuy=1 auto-opens the modal — useful
// for sharing direct-to-buy links from social posts and for QA /
// screenshots without having to click manually. Harmless if absent.
try {
  if (new URL(location.href).searchParams.get('openBuy') === '1') {
    setTimeout(() => window.openBuyModal(), 0);
  }
} catch { /* no-op if URL parsing fails (test env, etc.) */ }
