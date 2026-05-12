// ─── BUY $PYRE ──────────────────────────────────────────────────────
// Native swap UI on Jupiter's Swap V1 API. Input token is selectable
// (SOL / USDC / USDT); output is fixed to $PYRE. Slippage and priority
// fee level are user-configurable and persist via localStorage. The
// flow:
//
//   1. User picks input token (default SOL, remembered next visit)
//   2. User types amount → 600ms debounce → /quote with current
//      mint + persisted slippage. Quote cached 4s to stay under the
//      60 req/min lite-api rate limit.
//   3. /quote renders You-get + price impact + route + USD value
//   4. User clicks Swap → re-quote fresh → /swap → wallet sign → send
//   5. Confirm via lastValidBlockHeight (NOT a fresh getLatestBlockhash)
//   6. Success: Solscan link, balance refresh, form reset
//
// Wallet plumbing comes from js/wallet.js (shared with burn.js). We
// subscribe to onWalletChange so the UI tracks connect/disconnect/
// register/unregister without polling.
//
// Funds never touch pyrecoin.com — the wallet signs and we broadcast
// directly to our RPC proxy; Jupiter's contracts are the route, never
// a middleman we control.

import { VersionedTransaction, PublicKey } from '../vendor/web3.mjs';
import {
  PYRE_MINT_STR, isPlaceholder,
  SOL_MINT_STR, USDC_MINT_STR, USDT_MINT_STR,
  JUP, SWAP_DEFAULTS,
} from './config.js';
import { detectProvider, onWalletChange } from './wallet.js';
import { $, escapeHtml, fmt, fmtUsd, fmtAmount, trimDecimals, scaleToRaw } from './utils.js';
import { getConnection, getPyreDecimals } from './data.js';

// ─── constants ──────────────────────────────────────────────────────

// Quote debounce + cache: research says lite-api allows 60 req/min/IP.
// A 250ms keystroke debounce can briefly burst above that; 600ms keeps
// us safely under, and a 4s cache means rapid re-types of the same
// amount don't re-hit the API at all.
const QUOTE_DEBOUNCE_MS = 600;
const QUOTE_CACHE_TTL   = 4000;

// Input-token registry. Output is fixed to PYRE (the whole point of
// this surface). Adding more here is a one-liner — Jupiter handles
// routing for any mainnet mint, but the picker UI gets crowded fast,
// so we keep it to the three deposit tokens that cover 95% of cases.
//
// `feeReserve` is in UI units of the token. SOL keeps 0.01 SOL back
// for ATA rent + network + priority fee. Stablecoins don't need a
// reserve because the network fee comes out of the wallet's SOL,
// not the input mint.
const TOKENS = [
  { symbol: 'SOL',  name: 'Solana',    mint: SOL_MINT_STR,  decimals: 9, isNative: true,  feeReserve: 0.01, dotClass: 'buy-token-chip-dot-sol'  },
  { symbol: 'USDC', name: 'USD Coin',  mint: USDC_MINT_STR, decimals: 6, isNative: false, feeReserve: 0,    dotClass: 'buy-token-chip-dot-usdc' },
  { symbol: 'USDT', name: 'Tether',    mint: USDT_MINT_STR, decimals: 6, isNative: false, feeReserve: 0,    dotClass: 'buy-token-chip-dot-usdt' },
];

// ─── settings (persisted) ───────────────────────────────────────────

const SETTINGS_KEY = 'pyre.swapSettings';
const DEFAULT_SETTINGS = {
  slippageBps: SWAP_DEFAULTS.SLIPPAGE_BPS, // 3% static floor (memecoin-appropriate)
  dynamicSlippage: true,                   // Jupiter caps slippage between static + on-chain reality
  priorityLevel: 'veryHigh',               // 'medium' | 'high' | 'veryHigh'
  inputMint: SOL_MINT_STR,
};
function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const s = JSON.parse(raw);
    return {
      slippageBps: Number.isInteger(s.slippageBps) && s.slippageBps > 0 && s.slippageBps <= 5000
        ? s.slippageBps : DEFAULT_SETTINGS.slippageBps,
      dynamicSlippage: typeof s.dynamicSlippage === 'boolean'
        ? s.dynamicSlippage : DEFAULT_SETTINGS.dynamicSlippage,
      priorityLevel: ['medium','high','veryHigh'].includes(s.priorityLevel)
        ? s.priorityLevel : DEFAULT_SETTINGS.priorityLevel,
      inputMint: TOKENS.some(t => t.mint === s.inputMint)
        ? s.inputMint : DEFAULT_SETTINGS.inputMint,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

const settings = loadSettings();

// ─── state ──────────────────────────────────────────────────────────

const connection = getConnection();

let currentToken = TOKENS.find(t => t.mint === settings.inputMint) || TOKENS[0];

const buyState = {
  provider: null,
  publicKey: null,
  inputBalance: null,        // UI units of currentToken
  inputUsdPrice: null,       // USD price of currentToken from Jupiter
  lastQuote: null,
  quoting: false,
  swapping: false,
};

const _quoteCache = new Map();

// ─── helpers ────────────────────────────────────────────────────────

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
  const btn = $('buySubmit');
  if (!btn) return;
  btn.textContent = label;
  btn.disabled = disabled;
}

function toUiAmount(rawStr, decimals) {
  const raw = BigInt(rawStr);
  const denom = 10n ** BigInt(decimals);
  const whole = raw / denom;
  const frac = raw % denom;
  return Number(whole) + Number(frac) / Number(denom);
}

// ─── Jupiter API ────────────────────────────────────────────────────

async function fetchQuote(amountRaw) {
  // amountRaw is a string of the integer base-unit amount (lamports for
  // SOL, micro-USDC for USDC, etc.). Caching key includes the input
  // mint and slippage so settings changes invalidate.
  const key = `${currentToken.mint}|${PYRE_MINT_STR}|${amountRaw}|${settings.slippageBps}`;
  const cached = _quoteCache.get(key);
  if (cached && Date.now() - cached.ts < QUOTE_CACHE_TTL) return cached.data;
  const params = new URLSearchParams({
    inputMint: currentToken.mint,
    outputMint: PYRE_MINT_STR,
    amount: amountRaw,
    slippageBps: String(settings.slippageBps),
    swapMode: 'ExactIn',
    restrictIntermediateTokens: 'true',
  });
  const res = await fetch(`${JUP.QUOTE}?${params}`, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`quote ${res.status}${body ? ' · ' + body.slice(0, 160) : ''}`);
  }
  const data = await res.json();
  _quoteCache.set(key, { data, ts: Date.now() });
  return data;
}

async function fetchSwap(quoteResponse, userPublicKey) {
  const res = await fetch(JUP.SWAP, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: userPublicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: settings.dynamicSlippage,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          priorityLevel: settings.priorityLevel,
          maxLamports: SWAP_DEFAULTS.MAX_PRIORITY_LAMPORTS,
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

async function fetchInputUsdPrice() {
  // One USD price per active input token. Cached on buyState; refreshed
  // on token switch and when MAX/percentage paths recompute USD value.
  try {
    const res = await fetch(`${JUP.PRICE}?ids=${currentToken.mint}`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const p = data?.[currentToken.mint]?.usdPrice;
    if (typeof p === 'number' && isFinite(p) && p > 0) {
      buyState.inputUsdPrice = p;
      renderUsdValue();
    }
  } catch { /* keep last good price */ }
}

// ─── balance ─────────────────────────────────────────────────────────

async function refreshInputBalance() {
  if (!buyState.publicKey) {
    buyState.inputBalance = null;
    renderBalance();
    return;
  }
  try {
    if (currentToken.isNative) {
      const lamports = await connection.getBalance(buyState.publicKey);
      buyState.inputBalance = lamports / 1e9;
    } else {
      const mint = new PublicKey(currentToken.mint);
      const accounts = await connection.getParsedTokenAccountsByOwner(
        buyState.publicKey, { mint }
      );
      if (accounts.value.length > 0) {
        const info = accounts.value[0].account.data.parsed.info;
        buyState.inputBalance = parseFloat(info.tokenAmount.uiAmountString || '0');
      } else {
        buyState.inputBalance = 0;
      }
    }
  } catch (e) {
    console.warn('input balance fetch failed:', e);
  }
  renderBalance();
}

// ─── UI rendering ───────────────────────────────────────────────────

function renderBalance() {
  const el = $('buyBalance');
  if (el) el.textContent = buyState.inputBalance != null
    ? fmtAmount(buyState.inputBalance, currentToken.isNative ? 4 : 2)
    : '—';
  const symEl = $('buyBalanceSymbol');
  if (symEl) symEl.textContent = currentToken.symbol;
}

function renderTokenChip() {
  const label = $('buyTokenChipLabel');
  if (label) label.textContent = currentToken.symbol;
  const dot = $('buyTokenDot');
  if (dot) dot.className = 'buy-token-chip-dot ' + currentToken.dotClass;
}

function renderUsdValue() {
  const el = $('buyUsdValue');
  if (!el) return;
  const amt = parseFloat($('buyAmount')?.value);
  if (!Number.isFinite(amt) || amt <= 0 || buyState.inputUsdPrice == null) {
    el.textContent = '';
    return;
  }
  el.textContent = '≈ ' + fmtUsd(amt * buyState.inputUsdPrice);
}

function renderSettingsActive() {
  // Active-state for slippage and priority option buttons.
  document.querySelectorAll('[data-setting="slippage"] button').forEach(b => {
    b.classList.toggle('active', parseInt(b.dataset.value, 10) === settings.slippageBps);
  });
  document.querySelectorAll('[data-setting="priority"] button').forEach(b => {
    b.classList.toggle('active', b.dataset.value === settings.priorityLevel);
  });
  const dyn = $('buyDynamicSlippage');
  if (dyn) dyn.checked = settings.dynamicSlippage;
  const slipMeta = $('buySlippage');
  if (slipMeta) slipMeta.textContent = (settings.slippageBps / 100).toString().replace(/\.0$/, '') + '%';
  const prioMeta = $('buyPriorityLabel');
  if (prioMeta) {
    const map = { medium: 'Medium', high: 'High', veryHigh: 'Very High' };
    prioMeta.textContent = map[settings.priorityLevel] || settings.priorityLevel;
  }
}

function renderTokenPickerActive() {
  // Hide the currently-selected token from the picker — there's no
  // reason to offer "switch to the thing you're already on." The
  // remaining tokens are the actual choices.
  document.querySelectorAll('#buyTokenPicker button').forEach(b => {
    b.hidden = b.dataset.mint === currentToken.mint;
  });
}

// ─── popover toggles ────────────────────────────────────────────────

function setOpen(panelId, toggleId, open) {
  const panel = $(panelId);
  const toggle = $(toggleId);
  if (panel) panel.hidden = !open;
  if (toggle) toggle.setAttribute('aria-expanded', String(open));
}
function isOpen(panelId) {
  return $(panelId) && !$(panelId).hidden;
}
function closeAllPopovers() {
  setOpen('buyTokenPicker', 'buyTokenToggle', false);
  setOpen('buySettingsPanel', 'buySettingsToggle', false);
}

// ─── wallet / button state ──────────────────────────────────────────

function buttonLabelForCurrentState() {
  if (!buyState.provider) return 'Install a Solana wallet';
  if (!buyState.publicKey) return 'Connect wallet';
  const amt = parseFloat($('buyAmount')?.value);
  if (!Number.isFinite(amt) || amt <= 0) return 'Enter an amount';
  if (buyState.inputBalance != null && amt > buyState.inputBalance) {
    return `Insufficient ${currentToken.symbol}`;
  }
  if (buyState.quoting) return 'Quoting…';
  if (!buyState.lastQuote) return 'No quote — try again';
  return `Swap ${fmtAmount(amt, currentToken.isNative ? 6 : 2)} ${currentToken.symbol} for $PYRE`;
}

async function refreshWalletUI() {
  const provider = detectProvider();
  buyState.provider = provider;

  if (!provider) {
    buyState.publicKey = null;
    buyState.inputBalance = null;
    renderBalance();
    setSubmit('Install a Solana wallet', true);
    return;
  }
  if (!provider.publicKey) {
    buyState.publicKey = null;
    buyState.inputBalance = null;
    renderBalance();
    setSubmit('Connect wallet', false);
    return;
  }

  buyState.publicKey = provider.publicKey;
  await refreshInputBalance();
  scheduleQuote();
  setSubmit(buttonLabelForCurrentState(), false);
}

// ─── token switching ────────────────────────────────────────────────

async function selectToken(mint) {
  const tok = TOKENS.find(t => t.mint === mint);
  if (!tok || tok.mint === currentToken.mint) {
    closeAllPopovers();
    return;
  }
  currentToken = tok;
  settings.inputMint = mint;
  saveSettings();
  renderTokenChip();
  renderTokenPickerActive();
  closeAllPopovers();

  // Mint changed → cached quotes are useless, drop them. Re-quote
  // with the new mint as soon as we have a fresh price + balance.
  _quoteCache.clear();
  buyState.lastQuote = null;
  buyState.inputUsdPrice = null;
  const out = $('buyOutAmount');
  if (out) out.textContent = '—';
  const pi = $('buyPriceImpact');
  if (pi) pi.textContent = '—';
  const rt = $('buyRouteSummary');
  if (rt) rt.textContent = '';
  renderUsdValue();

  await Promise.all([refreshInputBalance(), fetchInputUsdPrice()]);
  scheduleQuote();
  setSubmit(buttonLabelForCurrentState(), false);
}

// ─── settings handlers ──────────────────────────────────────────────

function setSlippage(bps) {
  if (!Number.isInteger(bps) || bps <= 0 || bps > 5000) return;
  settings.slippageBps = bps;
  saveSettings();
  renderSettingsActive();
  _quoteCache.clear();
  scheduleQuote();
}
function setDynamicSlippage(enabled) {
  settings.dynamicSlippage = !!enabled;
  saveSettings();
  renderSettingsActive();
}
function setPriorityLevel(level) {
  if (!['medium','high','veryHigh'].includes(level)) return;
  settings.priorityLevel = level;
  saveSettings();
  renderSettingsActive();
}

// ─── percentage buttons ─────────────────────────────────────────────

function setPercent(pct) {
  if (buyState.inputBalance == null) return;
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return;
  let usable = buyState.inputBalance;
  if (currentToken.feeReserve > 0) {
    usable = Math.max(0, usable - currentToken.feeReserve);
  }
  const amount = (usable * pct) / 100;
  if (amount <= 0) {
    setStatus(`Balance too low to swap${currentToken.feeReserve > 0
      ? ` (reserve ~${currentToken.feeReserve} ${currentToken.symbol} for fees)` : ''}.`, 'error');
    return;
  }
  const input = $('buyAmount');
  if (input) {
    // Trim to the token's natural display precision so the field
    // doesn't show 9 decimals of noise.
    input.value = fmtAmount(amount, currentToken.isNative ? 6 : 2);
    clearStatus();
    renderUsdValue();
    scheduleQuote();
  }
}

// ─── quote pipeline ─────────────────────────────────────────────────

let _quoteDebounce = null;
function scheduleQuote() {
  clearTimeout(_quoteDebounce);
  _quoteDebounce = setTimeout(() => {
    runQuote().catch(e => {
      const out = $('buyOutAmount');
      if (out) out.textContent = '—';
      const pi = $('buyPriceImpact');
      if (pi) pi.textContent = '—';
      const rt = $('buyRouteSummary');
      if (rt) rt.textContent = '';
      buyState.lastQuote = null;
      setStatus(`Quote failed · ${escapeHtml(e.message)}`, 'error');
      setSubmit(buttonLabelForCurrentState(), false);
    });
  }, QUOTE_DEBOUNCE_MS);
}

async function runQuote() {
  const amt = parseFloat($('buyAmount')?.value);
  if (!Number.isFinite(amt) || amt <= 0) {
    const out = $('buyOutAmount');
    if (out) out.textContent = '—';
    const pi = $('buyPriceImpact');
    if (pi) pi.textContent = '—';
    const rt = $('buyRouteSummary');
    if (rt) rt.textContent = '';
    buyState.lastQuote = null;
    clearStatus();
    setSubmit(buttonLabelForCurrentState(), false);
    return;
  }
  const rawAmount = scaleToRaw(amt, currentToken.decimals).toString();
  buyState.quoting = true;
  setSubmit('Quoting…', true);
  try {
    const [q, decimals] = await Promise.all([fetchQuote(rawAmount), getPyreDecimals()]);
    buyState.lastQuote = q;
    const out = toUiAmount(q.outAmount, decimals);
    $('buyOutAmount').textContent = fmt(out);
    const piRaw = parseFloat(q.priceImpactPct);
    $('buyPriceImpact').textContent = Number.isFinite(piRaw)
      ? (piRaw * 100).toFixed(2) + '%'
      : '—';
    const route = (q.routePlan || [])
      .map(p => p.swapInfo?.label)
      .filter(Boolean)
      .join(' → ');
    $('buyRouteSummary').textContent = route ? `via ${route}` : '';
    clearStatus();
  } finally {
    buyState.quoting = false;
  }
  // setSubmit AFTER finally — see launch-window 67c06eb. Errors fall
  // through to the .catch in scheduleQuote which paints its own label.
  setSubmit(buttonLabelForCurrentState(), false);
}

// ─── swap submit ────────────────────────────────────────────────────

async function submitBuy() {
  if (buyState.swapping) return;

  if (isPlaceholder()) {
    setStatus('$PYRE has not launched yet.', 'error');
    return;
  }

  const provider = buyState.provider || detectProvider();
  if (!provider) { setStatus('No Solana wallet detected.', 'error'); return; }

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

  if (!buyState.lastQuote) {
    setStatus('Enter an amount first.', 'error');
    return;
  }

  const amt = parseFloat($('buyAmount')?.value);
  if (!Number.isFinite(amt) || amt <= 0) {
    setStatus('Enter a positive amount.', 'error');
    return;
  }
  if (buyState.inputBalance != null && amt > buyState.inputBalance) {
    setStatus(`Insufficient ${currentToken.symbol} balance.`, 'error');
    return;
  }

  buyState.swapping = true;
  setSubmit('Building transaction…', true);

  try {
    setStatus('Confirming route…', 'info');
    const rawAmount = scaleToRaw(amt, currentToken.decimals).toString();
    const freshQuote = await fetchQuote(rawAmount);
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
    await connection.confirmTransaction(
      { signature: sig, blockhash, lastValidBlockHeight: swap.lastValidBlockHeight },
      'confirmed'
    );

    const link = `https://solscan.io/tx/${sig}`;
    setStatus(
      `Swap confirmed · <a href="${link}" target="_blank" rel="noopener noreferrer">view on Solscan ↗</a>`,
      'success'
    );

    $('buyAmount').value = '';
    $('buyOutAmount').textContent = '—';
    $('buyPriceImpact').textContent = '—';
    $('buyRouteSummary').textContent = '';
    buyState.lastQuote = null;
    renderUsdValue();
    setSubmit('Swap again', false);
    await refreshInputBalance();
  } catch (e) {
    const raw = e?.message || String(e);
    let msg = raw;
    if (/User rejected|cancel/i.test(raw))     msg = 'Cancelled — nothing happened.';
    else if (/0x1771|slippage/i.test(raw))     msg = 'Price moved — try again or raise slippage in settings.';
    else if (/insufficient/i.test(raw))         msg = `Insufficient ${currentToken.symbol} for swap + fees.`;
    else if (/blockhash|expired/i.test(raw))    msg = 'Transaction expired — try again.';
    else if (/route|no liquidity/i.test(raw))   msg = 'No route found for that amount.';
    setStatus(`Swap failed · ${escapeHtml(msg)}`, 'error');
    setSubmit(buttonLabelForCurrentState(), false);
  } finally {
    buyState.swapping = false;
  }
}
window.submitBuy = submitBuy;

// trimDecimals is imported but unused here directly — kept in utils.js
// for the burn.js bill of sale. (no-op reference suppresses unused-
// import lint if anyone runs one in the future)
void trimDecimals;

// ─── event wiring ───────────────────────────────────────────────────

document.addEventListener('input', e => {
  if (e.target.id === 'buyAmount') {
    clearStatus();
    renderUsdValue();
    scheduleQuote();
  }
});
document.addEventListener('change', e => {
  if (e.target.id === 'buyDynamicSlippage') {
    setDynamicSlippage(e.target.checked);
  }
});

document.addEventListener('click', e => {
  // Settings toggle
  if (e.target.closest('#buySettingsToggle')) {
    const wasOpen = isOpen('buySettingsPanel');
    closeAllPopovers();
    if (!wasOpen) setOpen('buySettingsPanel', 'buySettingsToggle', true);
    return;
  }
  // Slippage buttons
  const slipBtn = e.target.closest('[data-setting="slippage"] button');
  if (slipBtn) {
    setSlippage(parseInt(slipBtn.dataset.value, 10));
    return;
  }
  // Priority buttons
  const prioBtn = e.target.closest('[data-setting="priority"] button');
  if (prioBtn) {
    setPriorityLevel(prioBtn.dataset.value);
    return;
  }
  // Token chip → open picker
  if (e.target.closest('#buyTokenToggle')) {
    const wasOpen = isOpen('buyTokenPicker');
    closeAllPopovers();
    if (!wasOpen) {
      renderTokenPickerActive();
      setOpen('buyTokenPicker', 'buyTokenToggle', true);
    }
    return;
  }
  // Token select
  const tokBtn = e.target.closest('#buyTokenPicker button');
  if (tokBtn) {
    selectToken(tokBtn.dataset.mint).catch(() => {});
    return;
  }
  // Percentage buttons
  const pctBtn = e.target.closest('.buy-percent-row button');
  if (pctBtn) {
    setPercent(parseInt(pctBtn.dataset.pct, 10));
    return;
  }
  // Click outside popovers → close (only when click is outside the
  // form's interactive controls — let buttons handle their own clicks)
  if (!e.target.closest('#buyTokenPicker, #buyTokenToggle, #buySettingsPanel, #buySettingsToggle')) {
    closeAllPopovers();
  }
});

// Escape key closes any open popover
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAllPopovers();
});

// React to wallet connect / disconnect / register events.
onWalletChange(() => { refreshWalletUI().catch(() => {}); });

// ─── boot ───────────────────────────────────────────────────────────

renderTokenChip();
renderSettingsActive();
refreshWalletUI().catch(() => {});
fetchInputUsdPrice();
getPyreDecimals().catch(() => {});
