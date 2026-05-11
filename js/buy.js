// ─── BUY BUTTON ─────────────────────────────────────────────────────
// Embeds Jupiter Terminal — Jupiter's drop-in swap widget — inside our
// own Buy modal. Routes across pump.fun bonding curve, Raydium, Orca,
// Phoenix, etc. — whichever has best execution at the moment.
//
// We deliberately keep wallet handling separate from the burn flow:
// Jupiter Terminal carries its own Wallet Standard adapter and a
// connect button inside the widget. That avoids two competing wallet-
// state machines (burn.js's and Terminal's) fighting over which is
// "active." Users can connect a different wallet to buy than they used
// to burn, which is fine — neither flow shares state.
//
// pyrecoin.com never custodies or touches funds at any point — the
// widget signs and broadcasts directly to the user's wallet and
// Jupiter's contracts. We're just hosting the iframe-equivalent.

import { PYRE_MINT_STR, RPC_URL, isPlaceholder } from './config.js';
import { $ } from './utils.js';

// Wrapped SOL — Jupiter Terminal expects mint addresses, not symbols.
// "So111…1112" is the wSOL mint that Jupiter normalises bare SOL to
// for routing purposes.
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Jupiter Terminal bundle. v3 is the current stable embed (2024-2025);
// self-mounts into a target element when configured with displayMode:
// 'integrated'. If this URL changes upstream, the widget will fail to
// load and we fall back to the "Open on jup.ag" link below.
const JUPITER_TERMINAL_SRC = 'https://terminal.jup.ag/main-v3.js';

// Public CORS-friendly Solana RPC used ONLY for Jupiter Terminal's
// internal account/balance/route lookups. Deliberately not our own
// rpc.pyrecoin.com worker proxy: (1) the worker's Origin allowlist
// rejects non-pyrecoin.com origins (breaks any dev/staging), and (2)
// the widget makes many RPC calls per session — routing this through
// our Helius free-tier key would drain that quota disproportionately
// for users who just want to swap. publicnode.com runs a free, public
// RPC pool with generous limits and no per-key cap; this is a
// well-understood pattern for embedded swap widgets.
const JUPITER_RPC_URL = 'https://solana-rpc.publicnode.com';

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
    s.src = JUPITER_TERMINAL_SRC;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      _jupScriptPromise = null;
      reject(new Error('Jupiter Terminal failed to load — CDN unreachable'));
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
    // 'integrated' mounts the swap UI into our existing target div, so
    // our modal frames it. 'modal' would give Jupiter its own backdrop
    // (would conflict with our modal); 'widget' is a floating button
    // (not what we want).
    displayMode: 'integrated',
    integratedTargetId: 'jupiter-target',
    // Separate RPC from the burn modal — see JUPITER_RPC_URL comment.
    // Burn flow still uses our worker proxy; only the swap widget uses
    // the public RPC, keeping our Helius quota for the burn-side
    // lookups that actually depend on it.
    endpoint: JUPITER_RPC_URL,
    formProps: {
      initialOutputMint: PYRE_MINT_STR,
      initialInputMint: SOL_MINT,
      // Don't lock the input — users with USDC/USDT also welcome.
      fixedOutputMint: true,
      fixedInputMint: false,
    },
    // Default to dark mode to match the rest of the site.
    defaultExplorer: 'Solscan',
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

// Escape-to-close. The burn modal doesn't have this (oversight), so
// adding it here as a UX nicety for the buy flow.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('buyModal')?.classList.contains('open')) {
    window.closeBuyModal();
  }
});

// Deep-link support: visiting pyrecoin.com/?openBuy=1 auto-opens the
// modal. Useful for sharing direct-to-buy links from social posts
// ("click here to buy $PYRE → ...") and for QA / screenshots without
// having to manually click. Harmless if the param is omitted.
try {
  if (new URL(location.href).searchParams.get('openBuy') === '1') {
    // Defer one tick so module-level wiring is fully attached.
    setTimeout(() => window.openBuyModal(), 0);
  }
} catch { /* no-op if URL parsing fails (test env, etc.) */ }
