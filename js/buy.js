// ─── BUY $PYRE ──────────────────────────────────────────────────────
// Custom SOL→$PYRE swap form built directly on Jupiter's free Swap V1
// API. Replaces Jupiter Plugin v1 (the React widget) with a native UI
// that matches the burn form's visual language, ~10KB instead of
// ~200KB, and zero shadow-DOM friction.
//
// Endpoints (lite-api.jup.ag — keyless, CORS-open):
//   GET  /swap/v1/quote   → routing + estimated output (cached 4s)
//   POST /swap/v1/swap    → serialized VersionedTransaction (v0)
//
// Flow:
//   1. User types SOL amount → 600ms debounce → /quote (rate-limit-safe)
//   2. /quote response renders You-get + price impact + route
//   3. User clicks Swap → re-quote fresh → /swap → wallet sign → send
//   4. Confirm via lastValidBlockHeight (NOT a fresh getLatestBlockhash)
//   5. Success: Solscan link, balance refresh, form reset
//
// Defaults (per Jupiter best practice for sub-$10M-mcap mints in 2026):
//   slippageBps: 300 (3%)        — static floor
//   dynamicSlippage: true        — bounded by slippageBps, gives back
//                                  headroom in calm pools
//   restrictIntermediateTokens   — keeps routes short, avoids hopping
//                                  through illiquid memecoins
//   priorityLevel: veryHigh      — landing rate for fresh memecoins
//   maxLamports: 2_000_000       — 0.002 SOL cap on priority cost
//   skipPreflight: true          — Jupiter already simulated the route
//   maxRetries: 0                — we control rebroadcast cadence
//
// Wallet plumbing comes from js/wallet.js (shared with burn.js). We
// subscribe to onWalletChange so the UI tracks connect/disconnect/
// register/unregister without polling.
//
// Funds never touch pyrecoin.com. The wallet signs and we broadcast
// directly to our RPC proxy; Jupiter's contracts are the route, never
// a middleman we control.

import {
  Connection, VersionedTransaction, PublicKey
} from 'https://esm.sh/@solana/web3.js@1.95.4';
import { PYRE_MINT_STR, RPC_URL, isPlaceholder } from './config.js';
import { detectProvider, onWalletChange } from './wallet.js';
import { $, escapeHtml, fmt } from './utils.js';

const SOL_MINT  = 'So11111111111111111111111111111111111111112';
const JUP_QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';
const JUP_SWAP  = 'https://lite-api.jup.ag/swap/v1/swap';

// Quote debounce + cache: research says lite-api allows 60 req/min/IP.
// A 250ms keystroke debounce can briefly burst above that; 600ms keeps
// us safely under, and a 4s cache means rapid re-types of the same
// amount don't re-hit the API at all.
const QUOTE_DEBOUNCE_MS = 600;
const QUOTE_CACHE_TTL   = 4000;

// 3% static slippage floor + dynamicSlippage:true. Static 1% fails
// constantly on sub-$10M-mcap memecoins; 3% is the sweet spot and
// dynamic gives back the headroom when the pool's calm.
const SLIPPAGE_BPS = 300;

// Reserve enough SOL for ATA rent + fees if user clicks MAX. Empirically
// safe across the swap shapes Jupiter builds: ATA creation (~0.00204) +
// network fee + priority cap. Leaving 0.01 SOL is a defensible default
// and protects users from accidentally bricking their account.
const MAX_SOL_RESERVE = 0.01;

const connection = new Connection(RPC_URL, 'confirmed');

const buyState = {
  provider: null,
  publicKey: null,
  solBalance: null,         // in SOL (not lamports)
  pyreDecimals: null,
  lastQuote: null,
  quoting: false,
  swapping: false,
  // last-known UI text on submit button — set by setSubmit, read by
  // re-render paths so they don't clobber a transient progress message.
  _submitText: 'Connect wallet',
  _submitDisabled: false,
};

const _quoteCache = new Map();

// ─── helpers ─────────────────────────────────────────────────────────

function setStatus(msg, kind = 'info') {
  const el = $('buyStatus');
  if (!el) return;
  el.className = 'burn-status ' + kind;
  el.innerHTML = msg;
}
function clearStatus() {
  const el = $('buyStatus');
  if (!el) return;
  el.className = 'burn-status';
  el.innerHTML = '';
}
function setSubmit(label, disabled = false) {
  buyState._submitText = label;
  buyState._submitDisabled = disabled;
  const btn = $('buySubmit');
  if (!btn) return;
  btn.textContent = label;
  btn.disabled = disabled;
}

// Format a number with up to maxDp decimals, stripping trailing zeros.
// Used for both SOL and PYRE readouts; the SOL field needs ≥6 decimals
// to render 0.001234 correctly, the PYRE field is integer-ish so the
// existing fmt() helper handles it (1.2K / 1.4M style).
function fmtSol(n, maxDp = 6) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  return n.toFixed(maxDp).replace(/0+$/, '').replace(/\.$/, '');
}

// Convert raw token units to a UI amount given decimals. Avoids
// floating-point precision loss for the integer division step.
function toUiAmount(rawStr, decimals) {
  const raw = BigInt(rawStr);
  const denom = 10n ** BigInt(decimals);
  const whole = raw / denom;
  const frac = raw % denom;
  // Compose a float — fine for display, since at 6 decimals we have ~15
  // significant digits of precision and PYRE supply is 1e9, well within.
  return Number(whole) + Number(frac) / Number(denom);
}

// ─── mint metadata (decimals) ───────────────────────────────────────

let _mintInfoPromise = null;
async function getPyreDecimals() {
  if (buyState.pyreDecimals != null) return buyState.pyreDecimals;
  if (_mintInfoPromise) return _mintInfoPromise;
  _mintInfoPromise = (async () => {
    const info = await connection.getParsedAccountInfo(new PublicKey(PYRE_MINT_STR));
    const d = info?.value?.data?.parsed?.info?.decimals;
    if (typeof d !== 'number') throw new Error('Could not read $PYRE decimals from mint');
    buyState.pyreDecimals = d;
    return d;
  })();
  return _mintInfoPromise;
}

// ─── Jupiter API ────────────────────────────────────────────────────

async function fetchQuote(amountLamports) {
  const key = `${SOL_MINT}|${PYRE_MINT_STR}|${amountLamports}|${SLIPPAGE_BPS}`;
  const cached = _quoteCache.get(key);
  if (cached && Date.now() - cached.ts < QUOTE_CACHE_TTL) return cached.data;
  const params = new URLSearchParams({
    inputMint: SOL_MINT,
    outputMint: PYRE_MINT_STR,
    amount: String(amountLamports),
    slippageBps: String(SLIPPAGE_BPS),
    swapMode: 'ExactIn',
    restrictIntermediateTokens: 'true',
  });
  const res = await fetch(`${JUP_QUOTE}?${params}`, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`quote ${res.status}${body ? ' · ' + body.slice(0, 160) : ''}`);
  }
  const data = await res.json();
  _quoteCache.set(key, { data, ts: Date.now() });
  return data;
}

async function fetchSwap(quoteResponse, userPublicKey) {
  // The body shape comes straight from the Jupiter Swap V1 reference.
  // Pass quoteResponse VERBATIM — Jupiter signs/validates the route
  // shape and any field-level mutation invalidates the build.
  const res = await fetch(JUP_SWAP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: userPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          priorityLevel: 'veryHigh',
          maxLamports: 2_000_000,
        },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`swap ${res.status}${body ? ' · ' + body.slice(0, 160) : ''}`);
  }
  return res.json();
}

// ─── wallet / balance ───────────────────────────────────────────────

async function refreshSolBalance() {
  if (!buyState.publicKey) {
    const el = $('buySolBalance');
    if (el) el.textContent = '—';
    return;
  }
  try {
    const lamports = await connection.getBalance(buyState.publicKey);
    buyState.solBalance = lamports / 1e9;
    const el = $('buySolBalance');
    if (el) el.textContent = fmtSol(buyState.solBalance, 4);
  } catch (e) {
    console.warn('SOL balance fetch failed:', e);
  }
}

function buttonLabelForCurrentState() {
  if (!buyState.provider) return 'Install a Solana wallet';
  if (!buyState.publicKey) return 'Connect wallet';
  const amt = parseFloat($('buyAmount')?.value);
  if (!Number.isFinite(amt) || amt <= 0) return 'Enter an amount';
  if (buyState.solBalance != null && amt > buyState.solBalance) return 'Insufficient SOL';
  if (buyState.quoting) return 'Quoting…';
  if (!buyState.lastQuote) return 'Quoting…';
  return `Swap ${fmtSol(amt, 6)} SOL for $PYRE`;
}

async function refreshWalletUI() {
  const provider = detectProvider();
  buyState.provider = provider;

  if (!provider) {
    buyState.publicKey = null;
    buyState.solBalance = null;
    const balEl = $('buySolBalance');
    if (balEl) balEl.textContent = '—';
    setSubmit('Install a Solana wallet', true);
    return;
  }

  if (!provider.publicKey) {
    buyState.publicKey = null;
    buyState.solBalance = null;
    const balEl = $('buySolBalance');
    if (balEl) balEl.textContent = '—';
    setSubmit('Connect wallet', false);
    return;
  }

  buyState.publicKey = provider.publicKey;
  await refreshSolBalance();
  // If the user already typed an amount, re-quote with the new wallet.
  scheduleQuote();
  setSubmit(buttonLabelForCurrentState(), false);
}

// ─── quote pipeline ─────────────────────────────────────────────────

let _quoteDebounce = null;
function scheduleQuote() {
  clearTimeout(_quoteDebounce);
  _quoteDebounce = setTimeout(() => {
    runQuote().catch(e => {
      // Common cause: amount too small. Render the readouts blank and
      // surface the Jupiter error so the user knows why nothing's
      // showing rather than thinking the page is broken.
      $('buyOutAmount').textContent = '—';
      $('buyPriceImpact').textContent = '—';
      $('buyRouteSummary').textContent = '';
      buyState.lastQuote = null;
      setStatus(`Quote failed · ${escapeHtml(e.message)}`, 'error');
      setSubmit(buttonLabelForCurrentState(), false);
    });
  }, QUOTE_DEBOUNCE_MS);
}

async function runQuote() {
  const amtSol = parseFloat($('buyAmount')?.value);
  if (!Number.isFinite(amtSol) || amtSol <= 0) {
    $('buyOutAmount').textContent = '—';
    $('buyPriceImpact').textContent = '—';
    $('buyRouteSummary').textContent = '';
    buyState.lastQuote = null;
    clearStatus();
    setSubmit(buttonLabelForCurrentState(), false);
    return;
  }
  const lamports = Math.round(amtSol * 1e9);
  buyState.quoting = true;
  setSubmit('Quoting…', true);
  try {
    const [q, decimals] = await Promise.all([fetchQuote(lamports), getPyreDecimals()]);
    buyState.lastQuote = q;
    const out = toUiAmount(q.outAmount, decimals);
    $('buyOutAmount').textContent = fmt(out);
    const pi = parseFloat(q.priceImpactPct);
    $('buyPriceImpact').textContent = Number.isFinite(pi)
      ? (pi * 100).toFixed(2) + '%'
      : '—';
    const route = (q.routePlan || [])
      .map(p => p.swapInfo?.label)
      .filter(Boolean)
      .join(' → ');
    $('buyRouteSummary').textContent = route ? `via ${route}` : '';
    clearStatus();
    setSubmit(buttonLabelForCurrentState(), false);
  } finally {
    buyState.quoting = false;
  }
}

// ─── swap submit ────────────────────────────────────────────────────

async function submitBuy() {
  if (buyState.swapping) return;

  // Refuse if placeholder mode (mint not yet configured). Defensive —
  // the live build flips runtime-config.json off placeholder at launch.
  if (isPlaceholder()) {
    setStatus('$PYRE has not launched yet.', 'error');
    return;
  }

  const provider = buyState.provider || detectProvider();
  if (!provider) { setStatus('No Solana wallet detected.', 'error'); return; }

  // Connect path — the button text was "Connect wallet" and the user
  // clicked it. Trigger the wallet's connect flow, then refresh the UI.
  if (!provider.publicKey) {
    try {
      await provider.connect();
    } catch (e) {
      setStatus(`Connect failed · ${escapeHtml(e.message || 'cancelled')}`, 'error');
      return;
    }
    await refreshWalletUI();
    return;
  }

  // From here on we need a quote.
  if (!buyState.lastQuote) {
    setStatus('Enter an amount first.', 'error');
    return;
  }

  const amtSol = parseFloat($('buyAmount')?.value);
  if (!Number.isFinite(amtSol) || amtSol <= 0) {
    setStatus('Enter a positive SOL amount.', 'error');
    return;
  }
  if (buyState.solBalance != null && amtSol > buyState.solBalance) {
    setStatus('Insufficient SOL balance.', 'error');
    return;
  }

  buyState.swapping = true;
  setSubmit('Building transaction…', true);

  try {
    // Re-quote fresh immediately before /swap. Stale-quote slippage
    // (0x1771) is the #1 production failure mode for memecoin swaps —
    // a quote from 8s ago can be off enough that the on-chain slippage
    // check fires. One last quote at click-time costs us 1 extra RPC
    // and saves the user from a failed-tx fee.
    setStatus('Confirming route…', 'info');
    const lamports = Math.round(amtSol * 1e9);
    const freshQuote = await fetchQuote(lamports);
    buyState.lastQuote = freshQuote;

    setStatus('Fetching swap transaction…', 'info');
    const swap = await fetchSwap(freshQuote, provider.publicKey);

    setStatus('Sign in your wallet…', 'info');
    const txBytes = Uint8Array.from(atob(swap.swapTransaction), c => c.charCodeAt(0));
    const tx = VersionedTransaction.deserialize(txBytes);
    const signed = await provider.signTransaction(tx);

    setStatus('Sending…', 'info');
    const raw = signed.serialize();
    const sig = await connection.sendRawTransaction(raw, {
      skipPreflight: true,
      maxRetries: 0,
    });

    setStatus('Confirming on chain…', 'info');
    const blockhash = signed.message.recentBlockhash;
    // Use Jupiter's lastValidBlockHeight, NOT a fresh getLatestBlockhash —
    // the embedded blockhash is already partway through its life.
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight: swap.lastValidBlockHeight },
      'confirmed'
    );

    const link = `https://solscan.io/tx/${sig}`;
    setStatus(
      `Swap confirmed · <a href="${link}" target="_blank" rel="noopener noreferrer">view on Solscan ↗</a>`,
      'success'
    );

    // Reset for another swap. Balance re-fetch picks up the new SOL
    // amount (post-fee) and pulls the user back to a clean state.
    $('buyAmount').value = '';
    $('buyOutAmount').textContent = '—';
    $('buyPriceImpact').textContent = '—';
    $('buyRouteSummary').textContent = '';
    buyState.lastQuote = null;
    setSubmit('Swap again', false);
    await refreshSolBalance();
  } catch (e) {
    // Human-readable failure mapping for the most common ones; everything
    // else falls back to the raw message.
    const raw = e?.message || String(e);
    let msg = raw;
    if (/User rejected|cancel/i.test(raw))     msg = 'Cancelled — nothing happened.';
    else if (/0x1771|slippage/i.test(raw))     msg = 'Price moved — try again or raise slippage.';
    else if (/insufficient/i.test(raw))         msg = 'Insufficient SOL for swap + fees.';
    else if (/blockhash|expired/i.test(raw))    msg = 'Transaction expired — try again.';
    else if (/route|no liquidity/i.test(raw))   msg = 'No route found for that amount.';
    setStatus(`Swap failed · ${escapeHtml(msg)}`, 'error');
    setSubmit(buttonLabelForCurrentState(), false);
  } finally {
    buyState.swapping = false;
  }
}
window.submitBuy = submitBuy;

// ─── event wiring ───────────────────────────────────────────────────

document.addEventListener('input', e => {
  if (e.target.id === 'buyAmount') {
    clearStatus();
    scheduleQuote();
  }
});

document.addEventListener('click', e => {
  if (e.target.id === 'buyMax') {
    e.preventDefault();
    if (buyState.solBalance == null) return;
    const usable = Math.max(0, buyState.solBalance - MAX_SOL_RESERVE);
    if (usable <= 0) {
      setStatus('Balance too low to swap (reserve ~0.01 SOL for fees).', 'error');
      return;
    }
    const input = $('buyAmount');
    if (input) {
      input.value = fmtSol(usable, 6);
      clearStatus();
      scheduleQuote();
    }
  }
});

// React to wallet connect / disconnect / register events.
onWalletChange(() => { refreshWalletUI().catch(() => {}); });

// Initial render. refreshWalletUI handles all branches (no wallet,
// detected-not-connected, connected). Pre-warming the mint decimals
// in the background means the first quote response renders instantly
// even when the network round-trip lands first.
refreshWalletUI().catch(() => {});
getPyreDecimals().catch(() => { /* will retry on first quote */ });
