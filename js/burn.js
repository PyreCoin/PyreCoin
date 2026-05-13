// ─── INSCRIBE / BURN ─────────────────────────────────────────────────
// Unified write surface. One inline form (in the #write section), one
// submit handler, two transaction shapes:
//
//   INSCRIBE  ($PYRE = 0): 1-lamport transfer to INSCRIPTION_BEACON +
//             Memo Program payload. Permanent on chain, indexed by
//             every Solana explorer. Costs ~5,000 lamport base fee +
//             ~10,000 lamport priority fee ≈ $0.003 at SOL = $200.
//
//   BURN+INSCRIBE  ($PYRE > 0): Token-2022 BurnChecked + Memo Program
//             payload. Destroys $PYRE at the protocol layer (mint
//             supply decreases — verifiable on every aggregator).
//             Costs the same SOL fees + the burned $PYRE. Lands on
//             the leaderboard, ranked by time-decayed heat.
//
// The beacon address is a PDA derived from "pyrecoin:inscriptions:v1"
// against the PYRE mint — off-curve, deterministic, no private key.
// The 1 lamport accumulates there forever; anyone can replicate the
// shape with their own wallet (no permission needed).
//
// Wallet plumbing comes from js/wallet.js (shared with buy.js) so all
// Wallet-Standard discovery is centralized — one registry, one set of
// subscribe handlers, one canonical detectProvider().
//
// Solana libs are imported from /vendor/ — single-file ESM bundles
// produced by esbuild against the npm packages and committed to the
// repo. Zero runtime CDN dependency. See vendor/README.md.

import {
  PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram,
} from '../vendor/web3.mjs';
import {
  createBurnCheckedInstruction, getAssociatedTokenAddressSync, getAccount,
  TOKEN_2022_PROGRAM_ID
} from '../vendor/spl-token.mjs';

import {
  PYRE_MINT_STR, MEMO_PROGRAM_ID_STR, INSCRIPTION_BEACON_STR, isPlaceholder,
  SOL_MINT_STR, JUP,
  BASE_LAMPORTS, PRIORITY_LAMPORTS, BEACON_LAMPORTS, INSCRIPTION_FEE_LAMPORTS,
} from './config.js';
import {
  $, shortAddr, escapeHtml, fmt, fmtUsdApprox, trimDecimals, scaleToRaw,
} from './utils.js';
import {
  getConnection, getPyreDecimals,
} from './data.js';
import {
  detectProvider, onWalletChange, disconnectWallet,
} from './wallet.js';
import {
  buildAtomicBurnTx, buildSwapOnlyTx, buildBurnOnlyTx, PAY_TOKENS,
} from './atomic-burn.js';

// ─── PYRE service-fee constant ──────────────────────────────────────
// Every inscription that goes through pyrecoin.com burns at least
// this much $PYRE (buy + burn atomically if the user doesn't already
// hold any). Transparent line item in the bill of sale; framed as a
// service fee for using the website, not as a token utility claim.
const SERVICE_FEE_PYRE = 1;

// Twitter / X handle validation — mirrors the server-side rule in
// scripts/lib/filter.mjs so the wallet prompt only fires for inputs
// that will survive moderation.
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

// pump.fun mints SPL tokens under the Token-2022 program (NOT the
// legacy Token program). This matters for THREE places: ATA address
// derivation, getAccount() reading, and transfer/ATA-creation
// instructions. If we use legacy defaults the ATA address is wrong
// and balance reads as 0 even when the user holds the token.
const TOKEN_PROGRAM = TOKEN_2022_PROGRAM_ID;

// Live USD prices for the four tokens the bill of sale needs to value:
// SOL (network fee + alt pay path), $PYRE (service fee + leaderboard
// burn), USDC and USDT (alt pay paths). One round-trip per refresh.
// Cached for 60s so we don't re-fetch on every keystroke.
const BILL_PRICE_MINTS = [SOL_MINT_STR, PYRE_MINT_STR, PAY_TOKENS.usdc.mint, PAY_TOKENS.usdt.mint];
const JUP_PRICE_URL = `${JUP.PRICE}?ids=${BILL_PRICE_MINTS.join(',')}`;
const _priceCache = { ts: 0, prices: { sol: null, pyre: null, usdc: null, usdt: null } };
async function fetchAllPrices(){
  if (Date.now() - _priceCache.ts < 60_000 && _priceCache.prices.sol != null) {
    return _priceCache.prices;
  }
  try {
    const res = await fetch(JUP_PRICE_URL, { cache: 'no-store' });
    if (!res.ok) return _priceCache.prices;
    const data = await res.json();
    const sol  = data?.[SOL_MINT_STR]?.usdPrice;
    const pyre = data?.[PYRE_MINT_STR]?.usdPrice;
    const usdc = data?.[PAY_TOKENS.usdc.mint]?.usdPrice;
    const usdt = data?.[PAY_TOKENS.usdt.mint]?.usdPrice;
    if (typeof sol  === 'number' && sol  > 0) _priceCache.prices.sol  = sol;
    if (typeof pyre === 'number' && pyre > 0) _priceCache.prices.pyre = pyre;
    if (typeof usdc === 'number' && usdc > 0) _priceCache.prices.usdc = usdc;
    if (typeof usdt === 'number' && usdt > 0) _priceCache.prices.usdt = usdt;
    _priceCache.ts = Date.now();
  } catch (_) { /* keep last-good prices */ }
  return _priceCache.prices;
}

// ─── STATE ───────────────────────────────────────────────────────────
const burnState = {
  provider: null,        // wallet provider (legacy injection or Wallet-Standard adapter)
  publicKey: null,       // user's wallet pubkey (web3.PublicKey)
  decimals: null,        // PYRE mint's decimals, queried on connect
  balance: null,         // user's $PYRE balance (uiAmount)
  // Pay method — one of: 'pyre' | 'sol' | 'usdc' | 'usdt'. The
  // 'pyre' option uses the user's existing $PYRE balance (no swap);
  // the others use Jupiter to acquire-and-burn atomically.
  payMethod: 'sol',
  // Whether the user has manually edited the burn amount input. When
  // false, we auto-suggest min-to-take-#1 on every leaderboard tick.
  // Set true on any input event or X-clear click.
  userEditedAmount: false,
  // True while a sign-and-submit is in flight. Locks the burn amount
  // input so the auto-prefill loop can't mutate the visible value
  // out from under the user mid-signature (see refreshBurnHint).
  signing: false,
};
const PAY_METHOD_KEY = 'pyre.burnPayMethod';
function loadPayMethod() {
  try {
    const v = localStorage.getItem(PAY_METHOD_KEY);
    if (['pyre','sol','usdc','usdt'].includes(v)) return v;
  } catch {}
  return 'sol';
}
function savePayMethod(v) {
  try { localStorage.setItem(PAY_METHOD_KEY, v); } catch {}
}
burnState.payMethod = loadPayMethod();

// ── Extra $PYRE to user's wallet ──
// Optional add-on: the same atomic tx acquires N more $PYRE on top of
// the burn amount and leaves it in the user's ATA (not burned). Default
// $10 USD-equivalent, on by default. Disabled automatically when the
// pay method is 'pyre' (you can't "buy more" if you're spending your
// own balance — show the row hidden in that case).
const EXTRA_ENABLED_KEY = 'pyre.burnExtraEnabled';
const EXTRA_USD_KEY = 'pyre.burnExtraUsd';
function loadExtraEnabled() {
  try {
    const v = localStorage.getItem(EXTRA_ENABLED_KEY);
    if (v === 'false') return false;
    if (v === 'true') return true;
  } catch {}
  return true; // default on
}
function loadExtraUsd() {
  try {
    const v = parseFloat(localStorage.getItem(EXTRA_USD_KEY));
    if (Number.isFinite(v) && v >= 0) return v;
  } catch {}
  return 10; // default $10
}
function saveExtraEnabled(v) {
  try { localStorage.setItem(EXTRA_ENABLED_KEY, String(!!v)); } catch {}
}
function saveExtraUsd(v) {
  try { localStorage.setItem(EXTRA_USD_KEY, String(v)); } catch {}
}
burnState.extraEnabled = loadExtraEnabled();
burnState.extraUsd = loadExtraUsd();

// ─── UI HELPERS ──────────────────────────────────────────────────────
function setStatus(msg, kind = 'info') {
  const el = $('burnStatus');
  el.className = 'burn-status ' + kind;
  el.innerHTML = msg;
}
function clearStatus(){
  $('burnStatus').className = 'burn-status';
  $('burnStatus').innerHTML = '';
}

// Reactive validation styling — adds .has-error to the .burn-form-row
// containing the given input id, triggering the red glow + shake
// keyframes defined in style.css. Cleared on next input event in
// that field (see the global 'input' listener below).
function flagRowError(inputId) {
  const input = $(inputId);
  const row = input?.closest('.burn-form-row');
  if (!row) return;
  // Restart the animation by toggling the class off-then-on across
  // a frame. Without this trick, re-flagging the same row inside the
  // same animation cycle is a no-op.
  row.classList.remove('has-error');
  // Force reflow so the class re-add re-triggers the keyframe.
  // eslint-disable-next-line no-unused-expressions
  void row.offsetWidth;
  row.classList.add('has-error');
}
function clearAllRowErrors() {
  document.querySelectorAll('.burn-form-row.has-error').forEach(r => r.classList.remove('has-error'));
}

// Auto-prefill the burn amount with min-to-take-#1 IF the user hasn't
// manually edited the field yet AND we're not mid-signature. Runs on
// every leaderboard tick from main.js.
function refreshBurnHint() {
  const lb = window.__pyreLeaderboard;
  const hintEl = $('burnHint');
  if (!lb || typeof lb.minBurnToTakeTop !== 'function') {
    if (hintEl) hintEl.innerHTML = '';
    return;
  }
  const min = lb.minBurnToTakeTop(new Date());
  const count = (typeof lb.liveEntryCount === 'function') ? lb.liveEntryCount() : 0;
  // Auto-suggest the take-#1 amount in the input until the user
  // overrides. Empty + auto = pre-fill; >0 + auto = pre-fill; X click
  // sets userEditedAmount and the value sticks at 0.
  //
  // Freeze while signing: the totalBurnAmt is captured at sign-time
  // in submitBurn, but the visible input keeps being live-updated
  // by this tick — and a user staring at the wallet popup that says
  // "burn 10,234" while the page below shows "burn 11,108" is a "what
  // you see ≠ what you sign" smell. Skip the prefill while the submit
  // button is disabled (= submission in flight).
  if (!burnState.userEditedAmount && !burnState.signing) {
    const input = $('burnAmount');
    if (input && count > 0) {
      input.value = String(min);
    } else if (input && count === 0) {
      input.value = '1';
    }
  }
  // Single hint line: render the take-#1 dollar amount as a clickable
  // snap-link when the input doesn't match it (snap = re-fill + drop
  // back into auto-suggest mode); render the same amount as plain
  // text when the input is already on target. The hint copy stays the
  // same either way so the layout never reflows when state toggles.
  if (hintEl) {
    if (count === 0) {
      hintEl.innerHTML = 'The pyre is cold — any burn takes <strong>#1</strong>.';
    } else {
      const input = $('burnAmount');
      const cur = parseFloat(input?.value);
      const onTarget = Number.isFinite(cur) && cur === min;
      const amt = `${escapeHtml(fmt(min))} $PYRE`;
      hintEl.dataset.takeTop = String(min);
      hintEl.innerHTML = onTarget
        ? `<strong>${amt}</strong> takes <strong>#1</strong> right now.`
        : `<button type="button" class="burn-hint-snap" data-snap="1">${amt}</button> takes <strong>#1</strong> right now.`;
    }
  }
  recalculateBill();
}
window.refreshBurnHint = refreshBurnHint;

// Live message char counter + bill of sale re-render + reactive
// validation reset. Any input event in a row that's currently
// .has-error clears the error glow — the user is actively fixing it.
document.addEventListener('input', e => {
  if (e.target.id === 'burnMsg') {
    const el = $('msgCount');
    if (el) el.textContent = e.target.value.length;
  }
  if (e.target.id === 'burnAmount') {
    burnState.userEditedAmount = true;
    recalculateBill();
    refreshBurnHint(); // refresh the snap-back link state
  }
  // Extra-PYRE USD input. Accept any non-negative number; let the
  // checkbox handle the "off" case explicitly.
  if (e.target.id === 'burnExtraUsd') {
    const v = parseFloat(e.target.value);
    if (Number.isFinite(v) && v >= 0) {
      burnState.extraUsd = v;
      saveExtraUsd(v);
      recalculateBill();
    }
  }
  // Always clear an error glow on this row when the user types.
  const row = e.target.closest?.('.burn-form-row');
  if (row && row.classList.contains('has-error')) {
    row.classList.remove('has-error');
  }
});

// Checkbox state change — toggle the extra-PYRE-to-wallet row on/off.
document.addEventListener('change', e => {
  if (e.target.id === 'burnExtraEnabled') {
    burnState.extraEnabled = !!e.target.checked;
    saveExtraEnabled(burnState.extraEnabled);
    recalculateBill();
  }
});

// ─── BILL OF SALE ─────────────────────────────────────────────────
// Renders the itemized cost breakdown beneath the form: Solana fee,
// service fee (1 $PYRE buy+burn), leaderboard burn (N $PYRE buy+burn),
// and the bottom-line "you pay" total in both USD and the chosen
// pay-with token. Re-runs on every input change, every leaderboard
// tick, every payMethod switch, and every price refresh.
function fmtPayAmount(amount, decimals, symbol) {
  if (!isFinite(amount) || amount <= 0) return `&approx; 0 ${symbol}`;
  const dp = decimals === 9 ? 6 : 4;
  return `&approx; ${trimDecimals(amount.toFixed(dp))} ${symbol}`;
}
function recalculateBill() {
  const billEl = $('burnBill');
  if (!billEl) return;
  const rawAmt = parseFloat($('burnAmount')?.value);
  const leaderboardAmt = (Number.isFinite(rawAmt) && rawAmt > 0) ? rawAmt : 0;
  const totalBurnAmt = SERVICE_FEE_PYRE + leaderboardAmt; // always at least the service fee
  const prices = _priceCache.prices;
  const solFeeSol = INSCRIPTION_FEE_LAMPORTS / 1e9;
  const solFeeUsd = prices.sol != null ? solFeeSol * prices.sol : null;
  const serviceUsd = prices.pyre != null ? SERVICE_FEE_PYRE * prices.pyre : null;
  const lbUsd = prices.pyre != null ? leaderboardAmt * prices.pyre : null;
  // Extra-PYRE-to-wallet line: $X swapped (not burned) into the user's
  // ATA alongside the burn. Only applies when the pay method is a
  // swap-source (SOL/USDC/USDT) — direct $PYRE pay method has no
  // swap step to piggyback on, so we hide the row entirely there.
  const extraEnabledNow = burnState.extraEnabled && burnState.payMethod !== 'pyre';
  const extraUsdValue = extraEnabledNow ? (burnState.extraUsd || 0) : 0;
  const extraPyreAmt = (extraUsdValue > 0 && prices.pyre != null && prices.pyre > 0)
    ? (extraUsdValue / prices.pyre) : 0;
  const totalUsd = (solFeeUsd ?? 0) + (serviceUsd ?? 0) + (lbUsd ?? 0) + extraUsdValue;

  // Render a USD cost split into integer + fractional spans so the
  // decimal points line up vertically in the bill column even when
  // magnitudes vary by 6+ orders ($0.0000040 ↔ $10.00). The integer
  // span is right-aligned to a fixed-width track in CSS; the
  // fractional span is left-aligned. Result: every `.` lands on the
  // same x.
  const setCostUsd = (id, usd) => {
    const el = $(id);
    if (!el) return;
    if (usd == null) { el.textContent = '—'; return; }
    const s = fmtUsdApprox(usd);
    const dot = s.indexOf('.');
    if (dot === -1) {
      el.innerHTML = `<span class="bb-int">${escapeHtml(s)}</span><span class="bb-frac"></span>`;
    } else {
      el.innerHTML =
        `<span class="bb-int">${escapeHtml(s.slice(0, dot))}</span>` +
        `<span class="bb-frac">${escapeHtml(s.slice(dot))}</span>`;
    }
  };

  // ── Each line item ──
  setCostUsd('burnBillSolFee', solFeeUsd);
  setCostUsd('burnBillService', serviceUsd);
  const lbRow = $('burnBillLeaderboardRow');
  if (leaderboardAmt > 0) {
    lbRow.hidden = false;
    $('burnBillBurnAmt').textContent = fmt(leaderboardAmt);
    setCostUsd('burnBillLeaderboard', lbUsd);
  } else {
    lbRow.hidden = true;
  }
  // Extra-PYRE-to-wallet — toggle now lives ABOVE the bill in its own
  // .burn-extra block; the bill carries only the cost line. Hide the
  // entire toggle (and the bill row) when payMethod=pyre.
  const extraToggle = $('burnBillExtraRow');
  const extraBillRow = $('burnBillExtraBillRow');
  const hideExtra = burnState.payMethod === 'pyre';
  if (extraToggle) {
    extraToggle.hidden = hideExtra;
    extraToggle.classList.toggle('is-off', !burnState.extraEnabled);
    const cb = $('burnExtraEnabled');
    if (cb && cb.checked !== burnState.extraEnabled) cb.checked = burnState.extraEnabled;
    const inp = $('burnExtraUsd');
    if (inp && parseFloat(inp.value) !== burnState.extraUsd && document.activeElement !== inp) {
      inp.value = burnState.extraUsd;
    }
    const pyreEl = $('burnBillExtraPyre');
    if (pyreEl) {
      pyreEl.textContent = extraPyreAmt > 0
        ? `≈ ${fmt(extraPyreAmt)} $PYRE`
        : '';
    }
  }
  if (extraBillRow) {
    // Show the bill row only when toggle is enabled AND has a > 0 value.
    extraBillRow.hidden = hideExtra || !burnState.extraEnabled || !(extraUsdValue > 0);
    setCostUsd('burnBillExtra', extraUsdValue > 0 ? extraUsdValue : null);
  }

  // ── Total in USD + pay-with-token equivalent ──
  setCostUsd('burnBillTotalUsd', totalUsd > 0 ? totalUsd : null);

  // Compute the pay-with-token amount. If 'pyre' is the pay method,
  // there's no swap — show just the $PYRE-burned total and the SOL fee
  // separately. For SOL/USDC/USDT we add the SOL network fee + the
  // swap cost (USD value / token price).
  const payTok = burnState.payMethod;
  const totalPayEl = $('burnBillTotalPay');
  if (payTok === 'pyre') {
    // The user pays SOL for network fees + (1 + N) $PYRE from balance.
    const pyreTotal = totalBurnAmt;
    totalPayEl.innerHTML = `&approx; ${fmt(pyreTotal)} $PYRE + ${trimDecimals(solFeeSol.toFixed(6))} SOL fee`;
  } else {
    const tokKey = payTok;
    const tokPrice = prices[tokKey];
    if (tokPrice == null || tokPrice <= 0) {
      totalPayEl.innerHTML = '&approx; — ' + tokKey.toUpperCase();
    } else {
      // Total USD / token's USD price = how many of that token to spend.
      // For SOL: includes its own network fee already (totalUsd has solFeeUsd).
      // For USDC/USDT: the SOL network fee comes from the user's SOL
      // wallet separately; the token covers only the burn-buy. So
      // subtract the SOL fee from the USD total before converting.
      let conversionUsd = totalUsd;
      if (tokKey !== 'sol') conversionUsd = Math.max(0, totalUsd - (solFeeUsd || 0));
      const tokAmount = conversionUsd / tokPrice;
      const dec = PAY_TOKENS[tokKey]?.decimals ?? 6;
      const sym = PAY_TOKENS[tokKey]?.symbol  ?? tokKey.toUpperCase();
      const extra = (tokKey !== 'sol' && solFeeUsd != null && prices.sol > 0)
        ? ` + ${trimDecimals((solFeeUsd / prices.sol).toFixed(6))} SOL fee`
        : '';
      totalPayEl.innerHTML = fmtPayAmount(tokAmount, dec, sym) + extra;
    }
  }

  // Submit button label — describes the action without restating the
  // burn amount (the bill above the button already itemizes it). Keep
  // the CTA verbal: action + outcome, no numbers.
  const btn = $('burnSubmit');
  if (btn && !btn.disabled && burnState.publicKey) {
    btn.textContent = 'Burn & inscribe';
  }
}

// ─── WALLET UI ───────────────────────────────────────────────────────
// Wallet discovery, picking, signing and disconnect all live in
// js/wallet.js — shared with buy.js so there's exactly one registry
// and one set of subscribe handlers. We just react to changes.

// Phantom/Solflare/Backpack sometimes inject window.solana 1-2 seconds
// after the page loads. The retry poller below catches that case so
// the form's submit button transitions from "Install a Solana wallet"
// to "Connect wallet" without requiring a page reload.
let _walletDetectPoller = null;
function stopWalletDetectPoller(){
  if (_walletDetectPoller){ clearInterval(_walletDetectPoller); _walletDetectPoller = null; }
}
function startWalletDetectPoller(){
  stopWalletDetectPoller();
  let retries = 8; // ~2s at 250ms intervals
  _walletDetectPoller = setInterval(() => {
    if (detectProvider() || --retries <= 0) {
      stopWalletDetectPoller();
      refreshWalletState();
    }
  }, 250);
}

function refreshWalletState() {
  const provider = detectProvider();
  const navSlot = $('navWallet');

  if (!provider) {
    if (navSlot) navSlot.innerHTML = '';
    $('burnSubmit').textContent = 'Install a Solana wallet';
    $('burnSubmit').disabled = true;
    return;
  }
  burnState.provider = provider;
  if (provider.publicKey) {
    burnState.publicKey = provider.publicKey;
    const addr = provider.publicKey.toString();
    if (navSlot) {
      // Address + disconnect only. Users know which wallet they have
      // installed — the "via Phantom" / picker text was redundant.
      // No inline onclick: the .wallet-disconnect button is wired via
      // the delegated click listener further down, which calls the
      // shared disconnectWallet() from wallet.js. Cleaner than an
      // onclick attribute and CSP-compatible.
      navSlot.innerHTML =
        `<span class="wallet-badge"><span class="wallet-addr" title="${escapeHtml(addr)}">${escapeHtml(shortAddr(addr))}</span>` +
        `<button type="button" class="wallet-disconnect" aria-label="Disconnect wallet" title="Disconnect">&times;</button></span>`;
    }
    $('burnSubmit').textContent = _submitLabel();
    $('burnSubmit').disabled = false;
  } else {
    // Provider detected but no key — clear the nav slot; the modal's
    // submit button doubles as the connect trigger ("Connect wallet").
    if (navSlot) navSlot.innerHTML = '';
    $('burnSubmit').textContent = 'Connect wallet';
    $('burnSubmit').disabled = false;
  }
}

// Subscribe to wallet-state changes — register/unregister, pick,
// disconnect. wallet.js notifies us via this hook so we don't need
// our own retry loops or registry.
onWalletChange(() => { refreshWalletState(); });

function _submitLabel(){
  // The numeric burn amount is shown in the bill of sale right above
  // the button; the button itself stays a clean verb phrase so the
  // CTA's job (commit the action) is what registers.
  return 'Burn & inscribe';
}

// ── delegated click handler ──
// One listener handles every clickable inside the write surface:
//   * clear (×) on the burn-amount input
//   * snap-back-to-take-#1 link
//   * pay-with chip toggle
//   * pay-with option click
//   * close-on-click-outside for the pay picker
//   * wallet disconnect (× button in the nav badge — no inline onclick)
document.addEventListener('click', e => {
  // Wallet disconnect
  if (e.target.closest('.wallet-disconnect')) {
    disconnectWallet().catch(() => {});
    return;
  }
  // Clear ×: drop leaderboard burn to 0 (service fee still applies).
  const clearBtn = e.target.closest('#burnAmountClear');
  if (clearBtn) {
    e.preventDefault();
    const input = $('burnAmount');
    if (input) {
      input.value = '0';
      burnState.userEditedAmount = true;
      recalculateBill();
      refreshBurnHint();
      input.focus();
    }
    return;
  }
  // Snap-back-to-take-#1: the dollar amount inside .burn-hint renders
  // as a button whenever the input value doesn't match the live target.
  const snap = e.target.closest('.burn-hint-snap');
  if (snap) {
    e.preventDefault();
    const input = $('burnAmount');
    const n = $('burnHint')?.dataset?.takeTop;
    if (input && n) {
      input.value = n;
      burnState.userEditedAmount = false;
      recalculateBill();
      refreshBurnHint();
    }
    return;
  }
  // Pay-with chip toggle
  const payToggle = e.target.closest('#burnPayToggle');
  if (payToggle) {
    const picker = $('burnPayPicker');
    if (!picker) return;
    const willOpen = picker.hidden;
    picker.hidden = !willOpen;
    payToggle.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) renderBurnPayPickerActive();
    return;
  }
  // Pay-with option
  const payOpt = e.target.closest('#burnPayPicker button[data-pay]');
  if (payOpt) {
    const val = payOpt.dataset.pay;
    if (['pyre','sol','usdc','usdt'].includes(val)) {
      burnState.payMethod = val;
      savePayMethod(val);
      renderBurnPayChip();
      recalculateBill();
    }
    const picker = $('burnPayPicker');
    const toggle = $('burnPayToggle');
    if (picker) picker.hidden = true;
    if (toggle) toggle.setAttribute('aria-expanded', 'false');
    return;
  }
  // Click outside the chip → close
  if (!e.target.closest('#burnPayPicker, #burnPayToggle')) {
    const picker = $('burnPayPicker');
    const toggle = $('burnPayToggle');
    if (picker && !picker.hidden) {
      picker.hidden = true;
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }
  }
});

// Esc closes the pay picker
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const picker = $('burnPayPicker');
    const toggle = $('burnPayToggle');
    if (picker && !picker.hidden) {
      picker.hidden = true;
      if (toggle) toggle.setAttribute('aria-expanded', 'false');
    }
  }
});

const PAY_VISUALS = {
  pyre: { label: '$PYRE', dotClass: 'buy-token-chip-dot-pyre' },
  sol:  { label: 'SOL',   dotClass: 'buy-token-chip-dot-sol'  },
  usdc: { label: 'USDC',  dotClass: 'buy-token-chip-dot-usdc' },
  usdt: { label: 'USDT',  dotClass: 'buy-token-chip-dot-usdt' },
};
function renderBurnPayChip() {
  const v = PAY_VISUALS[burnState.payMethod] || PAY_VISUALS.sol;
  const lbl = $('burnPayLabel');
  const dot = $('burnPayDot');
  if (lbl) lbl.textContent = v.label;
  if (dot) dot.className = 'buy-token-chip-dot ' + v.dotClass;
}
function renderBurnPayPickerActive() {
  document.querySelectorAll('#burnPayPicker button[data-pay]').forEach(b => {
    b.classList.toggle('active', b.dataset.pay === burnState.payMethod);
  });
}

async function refreshBalance() {
  if (!burnState.publicKey) return;
  if (isPlaceholder()) return;
  try {
    const conn = getConnection();
    const mint = new PublicKey(PYRE_MINT_STR);
    const ata = getAssociatedTokenAddressSync(mint, burnState.publicKey, false, TOKEN_PROGRAM);
    const acct = await getAccount(conn, ata, undefined, TOKEN_PROGRAM);
    if (burnState.decimals === null) {
      burnState.decimals = await getPyreDecimals();
    }
    burnState.balance = Number(acct.amount) / 10 ** burnState.decimals;
  } catch (e) {
    // Distinguish 'no token account' (= balance is genuinely 0) from
    // RPC/network failure (= balance unknown). submitBurn's pre-flight
    // check relies on the distinction: a burn against an unknown
    // balance MUST be refused, not silently sent.
    if (e?.name === 'TokenAccountNotFoundError') {
      burnState.balance = 0;
    } else {
      burnState.balance = null;
    }
  }
}

// Browser-side URL validation. The server-side moderation pipeline
// (scripts/lib/filter.mjs) is the authoritative gate, but burning is
// permanent — we should refuse to send anything obviously bogus
// before it costs the user their tokens. Strips a leading protocol
// (the leaderboard re-prepends https:// when rendering), rejects
// protocol-confusable schemes, requires at least domain.tld shape,
// and bans the pipe character (the memo parser uses it as a
// separator — a URL containing '|' would silently quarantine).
function normalizeBurnUrl(input) {
  const raw = (input || '').trim();
  if (!raw) return null;
  if (/^(javascript|data|vbscript|file|about):/i.test(raw)) return null;
  if (raw.includes('|')) return null;
  const stripped = raw.replace(/^https?:\/\//i, '');
  if (!stripped || /\s/.test(stripped) || !/\./.test(stripped)) return null;
  try {
    const u = new URL('https://' + stripped);
    if (!u.hostname || !u.hostname.includes('.')) return null;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return null; // no IP-literal URLs (per moderation policy)
    return stripped;
  } catch { return null; }
}

// Poll getSignatureStatus until the tx confirms, errors, or expires.
// Rationale: confirmTransaction would (a) open a wss:// subscription
// our HTTP-only Worker proxy can't service, and (b) couple confirmation
// detection to lastValidBlockHeight in a way that throws a cryptic
// "Signature has expired" even when the chain is still trying to land
// the tx. We poll explicitly with clear, money-context-appropriate
// failure messages: in every error case below, the user's tokens are
// still safely in their wallet (the chain de-dupes by signature; an
// expired blockhash means the burn never executed; a chain-rejected tx
// means the program errored before any token movement).
async function pollForConfirmation(conn, signature, lastValidBlockHeight) {
  const pollStart = Date.now();
  const timeoutMs = 90_000;
  let cycle = 0;

  while (Date.now() - pollStart < timeoutMs) {
    await new Promise(r => setTimeout(r, 1500));
    cycle++;

    const r = await conn.getSignatureStatus(signature, { searchTransactionHistory: false });
    const v = r?.value;

    if (v?.err) {
      throw new Error(
        'The chain rejected the transaction — nothing was moved. ' +
        'Reason: ' + JSON.stringify(v.err)
      );
    }
    if (v?.confirmationStatus === 'confirmed' || v?.confirmationStatus === 'finalized') {
      return v;
    }

    // Every ~5 polls (~7.5s), check whether the blockhash window has
    // closed. Avoids paying for getBlockHeight on every cycle while
    // still surfacing expiry within a useful window.
    if (cycle % 5 === 0) {
      try {
        const h = await conn.getBlockHeight('confirmed');
        if (h > lastValidBlockHeight + 5) {
          throw new Error(
            'BLOCKHASH_EXPIRED: The transaction expired before landing on chain. ' +
            'This happens when the wallet-confirm step takes longer than ~60 seconds. ' +
            'Nothing was moved.'
          );
        }
      } catch (e) {
        if (e.message?.startsWith('BLOCKHASH_EXPIRED')) throw e;
        // getBlockHeight RPC blip — ignore and keep polling status
      }
    }
  }
  throw new Error(
    'TIMEOUT: The transaction did not confirm within 90 seconds. ' +
    'It may still land — check the Solscan link. Nothing was moved ' +
    'unless Solscan shows the instruction confirmed in a block.'
  );
}

// ─── SUBMIT (INSCRIBE OR BURN+INSCRIBE) ──────────────────────────────
// Unified handler. Reads four optional fields (msg, url, x handle,
// PYRE amount). Builds either a memo-only inscription tx or a
// burnChecked+memo tx, depending on whether PYRE amount > 0.
//
// Validation rules:
//   - At least one of (msg, url, x, amount > 0) must be provided.
//     Otherwise there's nothing to inscribe and no PYRE to burn.
//   - URL (if provided): basic shape check; full moderation runs
//     server-side on ingest.
//   - X handle (if provided): 1–15 chars, alphanumeric + underscore
//     (same rule as filterMemo on the server).
//   - No `|` characters in any field (the memo parser uses `|` as
//     the segment separator).
window.submitBurn = async function submitBurn() {
  clearStatus();
  if (isPlaceholder()) {
    setStatus('$PYRE has not launched yet. The inscribe/burn buttons activate once the token mint is configured.', 'error');
    return;
  }

  // Clear any prior error glow before re-validating.
  clearAllRowErrors();

  // Read content fields. At least one of msg/url/xh is required — the
  // 1 $PYRE service fee alone isn't a reason to inscribe (otherwise
  // every page reload could spam an empty memo into the wall).
  const rawUrl = $('burnUrl')?.value || '';
  const url    = rawUrl.trim() ? normalizeBurnUrl(rawUrl) : '';
  if (rawUrl.trim() && !url) {
    flagRowError('burnUrl');
    setStatus('That URL doesn\'t look right — try something like <code>yoursite.xyz</code> (no spaces, no <code>|</code>).', 'error');
    return;
  }
  const msg = ($('burnMsg')?.value || '').trim();
  let   xh  = ($('burnX')?.value   || '').trim().replace(/^@/, '');
  const rawAmt = parseFloat($('burnAmount')?.value);
  const leaderboardAmt = (Number.isFinite(rawAmt) && rawAmt > 0) ? rawAmt : 0;
  // Total burn = service fee (always) + optional leaderboard layer.
  // Always at least SERVICE_FEE_PYRE > 0, so the BurnChecked
  // instruction is always present in the tx.
  const totalBurnAmt = SERVICE_FEE_PYRE + leaderboardAmt;

  if (!msg && !url && !xh) {
    // Light up all three content rows so the user can see exactly
    // which fields need anything in them. Status line stays short —
    // the visual feedback IS the explanation.
    flagRowError('burnMsg');
    flagRowError('burnUrl');
    flagRowError('burnX');
    setStatus('Add a message, a URL, or an X handle — at least one.', 'error');
    return;
  }
  if (msg.includes('|')) { flagRowError('burnMsg'); setStatus('The <code>|</code> character is reserved.', 'error'); return; }
  if (url && url.includes('|')) { flagRowError('burnUrl'); setStatus('The <code>|</code> character is reserved.', 'error'); return; }
  if (xh.includes('|')) { flagRowError('burnX'); setStatus('The <code>|</code> character is reserved.', 'error'); return; }
  if (xh && !X_HANDLE_RE.test(xh)) {
    flagRowError('burnX');
    setStatus('X handle: 1–15 letters, numbers, or underscores.', 'error');
    return;
  }

  const provider = detectProvider();
  if (!provider) {
    setStatus('No Solana wallet found. Install one — ' +
      '<a href="https://phantom.app" target="_blank" rel="noopener noreferrer">Phantom</a>, ' +
      '<a href="https://jup.ag/wallet" target="_blank" rel="noopener noreferrer">Jupiter</a>, ' +
      '<a href="https://solflare.com" target="_blank" rel="noopener noreferrer">Solflare</a>, ' +
      '<a href="https://backpack.app" target="_blank" rel="noopener noreferrer">Backpack</a>, ' +
      'or any other Solana wallet that supports the Wallet Standard.',
      'error');
    return;
  }

  $('burnSubmit').disabled = true;
  burnState.signing = true;
  setStatus('Connecting wallet…', 'info');

  try {
    if (!provider.isConnected) await provider.connect();
    burnState.provider = provider;
    burnState.publicKey = provider.publicKey;

    const payMethod = burnState.payMethod;
    const isDirectPyre = payMethod === 'pyre';

    if (isDirectPyre) {
      // Direct path requires the user to already hold >= totalBurnAmt PYRE.
      // If not, point them at switching the pay method instead of failing.
      await refreshBalance();
      if (burnState.balance === null) {
        throw new Error('Couldn\'t verify your $PYRE balance (RPC failed). Try again in a moment.');
      }
      if (totalBurnAmt > burnState.balance) {
        throw new Error('You only have ' + burnState.balance.toLocaleString() +
          ' $PYRE — not enough to cover the ' + fmt(totalBurnAmt) + ' $PYRE burn. ' +
          'Switch the pay-with chip to SOL/USDC/USDT to acquire-and-burn atomically.');
      }
    }

    setStatus('Building transaction…', 'info');

    const conn = getConnection();
    const sender = burnState.publicKey;

    // Build memo from non-empty fields, in canonical order url|x|msg.
    const memoParts = [];
    if (url) memoParts.push('url=' + url);
    if (xh)  memoParts.push('x=' + xh);
    if (msg) memoParts.push('msg=' + msg);
    const memoText = memoParts.join(' | ');

    let tx;                       // Transaction | VersionedTransaction
    let lastValidBlockHeight;     // for confirmation timeout

    if (isDirectPyre) {
      // ── DIRECT PATH ── legacy Transaction; user has enough $PYRE
      // already. One BurnChecked + Memo + 1-lamport beacon (for
      // inscription wall indexing) in a single signature.
      const mint = new PublicKey(PYRE_MINT_STR);
      if (burnState.decimals === null) {
        burnState.decimals = await getPyreDecimals();
      }
      const senderAta = getAssociatedTokenAddressSync(mint, sender, false, TOKEN_PROGRAM);
      // Integer-math scaling avoids 0.1+0.2 float drift on fractional
      // burn amounts. Shared with atomic-burn.js + buy.js (utils.scaleToRaw).
      const rawAmount = scaleToRaw(totalBurnAmt, burnState.decimals);
      const legacyTx = new Transaction();
      legacyTx.add(ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: PRIORITY_LAMPORTS * 1000 / 200
      }));
      legacyTx.add(createBurnCheckedInstruction(
        senderAta, mint, sender, rawAmount, burnState.decimals, [], TOKEN_PROGRAM
      ));
      legacyTx.add(new TransactionInstruction({
        keys: [{ pubkey: sender, isSigner: true, isWritable: false }],
        programId: new PublicKey(MEMO_PROGRAM_ID_STR),
        data: new TextEncoder().encode(memoText),
      }));
      // 1-lamport beacon so the ingest's getSignaturesForAddress(beacon)
      // scan also picks this up — both leaderboard and inscription wall
      // indexers see the tx.
      legacyTx.add(SystemProgram.transfer({
        fromPubkey: sender,
        toPubkey: new PublicKey(INSCRIPTION_BEACON_STR),
        lamports: BEACON_LAMPORTS,
      }));
      const bh = await conn.getLatestBlockhash('processed');
      legacyTx.recentBlockhash = bh.blockhash;
      legacyTx.feePayer = sender;
      tx = legacyTx;
      lastValidBlockHeight = bh.lastValidBlockHeight;
    } else {
      // ── ATOMIC PATH ── one VersionedTransaction that swaps from
      // (SOL|USDC|USDT) → PYRE via Jupiter, burns the output, attaches
      // the memo, all signed once. See js/atomic-burn.js.
      const payMint = PAY_TOKENS[payMethod]?.mint;
      if (!payMint) throw new Error('Invalid pay method: ' + payMethod);
      // Compute the extra-PYRE-to-wallet amount from the user's
      // checkbox/USD input + the live $PYRE price. The atomic builder
      // acquires (burn + extra) and burns only the burn portion; the
      // extra stays in the user's ATA.
      const prices = _priceCache.prices;
      const extraPyreAmt = (burnState.extraEnabled && (burnState.extraUsd || 0) > 0
        && prices.pyre != null && prices.pyre > 0)
        ? (burnState.extraUsd / prices.pyre) : 0;
      setStatus('Quoting Jupiter swap…', 'info');
      const built = await buildAtomicBurnTx({
        conn,
        payer: sender,
        payMint,
        totalBurnAmt,
        extraPyreAmt,
        memoText,
      });
      if (built.sizeBytes > 1232) {
        // ── 2-TX FALLBACK ── Jupiter's route is too dense to fit
        // alongside our burn+memo+beacon in a single 1232-byte tx.
        // Split into two: first acquire the $PYRE (Jupiter swap only),
        // then burn + memo + beacon as a small follow-up tx. The user
        // signs twice. If they cancel the second sig, they keep the
        // freshly-acquired $PYRE in their wallet — no refund path.
        if (typeof provider.signTransaction !== 'function') {
          throw new Error('Your wallet does not expose signTransaction. Try Phantom, Jupiter, Solflare, or Backpack.');
        }
        setStatus(
          `Route too dense for one tx (${built.sizeBytes} bytes &gt; 1232 limit) &mdash; ` +
          'switching to <strong>2-signature mode</strong>. You\'ll sign once to acquire ' +
          'the $PYRE, then again to burn + inscribe.', 'info'
        );

        // tx1: swap only (includes extra-to-wallet PYRE in the acquire)
        const swap = await buildSwapOnlyTx({ payer: sender, payMint, totalBurnAmt, extraPyreAmt });
        setStatus('<strong>Sign 1 of 2</strong> in your wallet &mdash; acquire $PYRE&hellip;', 'info');
        const swapSigned = await provider.signTransaction(swap.tx);
        const swapSig = await conn.sendRawTransaction(swapSigned.serialize(), {
          skipPreflight: true, maxRetries: 10, preflightCommitment: 'confirmed',
        });
        setStatus(
          `Step 1 sent: <a href="https://solscan.io/tx/${swapSig}" target="_blank" rel="noopener noreferrer">${shortAddr(swapSig)} &uarr;</a> ` +
          '&middot; waiting for $PYRE to land&hellip;', 'info'
        );
        await pollForConfirmation(conn, swapSig, swap.lastValidBlockHeight);

        // tx2: burn + memo + beacon. Built AFTER tx1 confirms so the
        // blockhash is fresh and the user's ATA definitely has the
        // requested $PYRE.
        const burn = await buildBurnOnlyTx({ conn, payer: sender, totalBurnAmt, memoText });
        setStatus('<strong>Sign 2 of 2</strong> in your wallet &mdash; burn + inscribe&hellip;', 'info');
        const burnSigned = await provider.signTransaction(burn.tx);
        const burnSig = await conn.sendRawTransaction(burnSigned.serialize(), {
          skipPreflight: false, maxRetries: 10, preflightCommitment: 'confirmed',
        });
        setStatus(
          `Step 2 sent: <a href="https://solscan.io/tx/${burnSig}" target="_blank" rel="noopener noreferrer">${shortAddr(burnSig)} &uarr;</a> ` +
          '&middot; waiting for confirmation&hellip;', 'info'
        );
        await pollForConfirmation(conn, burnSig, burn.lastValidBlockHeight);

        setStatus(
          `🔥 ${fmt(totalBurnAmt)} $PYRE burned across <strong>2 transactions</strong>. ` +
          'Your slot will appear on the leaderboard within ~10 minutes once the indexer picks it up.<br>' +
          `<a href="https://solscan.io/tx/${swapSig}" target="_blank" rel="noopener noreferrer">Swap tx &uarr;</a> &middot; ` +
          `<a href="https://solscan.io/tx/${burnSig}" target="_blank" rel="noopener noreferrer">Burn tx &uarr;</a>`,
          'success'
        );
        await refreshBalance();
        // Done with the 2-tx flow — skip the single-tx sign+send block
        // below by setting tx to null and returning out of the try.
        $('burnSubmit').disabled = false;
        burnState.signing = false;
        return;
      }
      tx = built.tx;
      lastValidBlockHeight = built.lastValidBlockHeight;
    }

    setStatus('Confirm in your wallet&hellip;', 'info');

    // Both paths have already baked their blockhash + payer into the
    // tx (legacy: tx.recentBlockhash / tx.feePayer; v0: TransactionMessage
    // compiled with payerKey + recentBlockhash). No additional setup
    // needed here.
    if (typeof provider.signTransaction !== 'function') {
      throw new Error('Your wallet does not expose signTransaction. Try Phantom, Jupiter, Solflare, or Backpack.');
    }
    // wallet.js's adapter auto-detects VersionedTransaction (via
    // tx.version) and serializes accordingly. Sign returns the same
    // type that came in.
    const signedTx = await provider.signTransaction(tx);
    // Skip preflight on the atomic path — Jupiter already simulated
    // the route; the extra preflight pass tends to false-positive on
    // Token-2022 / pump.fun routes and just slows landing.
    const signature = await conn.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: !isDirectPyre,
      maxRetries: 10,
      preflightCommitment: 'confirmed',
    });

    setStatus('Submitted. Waiting for confirmation…<br>' +
      '<a href="https://solscan.io/tx/' + signature + '" target="_blank" rel="noopener noreferrer">' + shortAddr(signature) + ' ↗</a>', 'info');

    // Poll getSignatureStatus directly. We avoid confirmTransaction here
    // because it (a) opens a wss:// subscription that our HTTP-only
    // Worker proxy can't service (loud console errors, slow fallback)
    // and (b) couples confirmation detection to lastValidBlockHeight in
    // a way that fires "Signature has expired" prematurely.
    await pollForConfirmation(conn, signature, lastValidBlockHeight);

    // Every successful flow now burns at least the service fee — single
    // success copy. The leaderboard sees the burn; the inscription wall
    // sees the beacon transfer. Both indexers pick it up on the next
    // 5-minute ingest cycle.
    setStatus(
      `🔥 ${fmt(totalBurnAmt)} $PYRE burned. ` +
      'Your slot will appear on the leaderboard within ~10 minutes once the indexer picks it up.<br>' +
      '<a href="https://solscan.io/tx/' + signature + '" target="_blank" rel="noopener noreferrer">View transaction ↗</a>',
      'success'
    );
    await refreshBalance();
  } catch (err) {
    const m = err?.message || String(err);
    const ml = m.toLowerCase();
    let msg;
    if (ml.includes('user rejected') || ml.includes('user canceled') || ml.includes('user cancelled')) {
      msg = 'Transaction cancelled in wallet — <strong>nothing was sent.</strong>';
    } else if (m.startsWith('BLOCKHASH_EXPIRED') || ml.includes('blockhash not found') || ml.includes('signature has expired') || ml.includes('block height exceeded')) {
      // The blockhash on the signed tx aged past its 150-slot validity
      // window before the leader could include it.
      msg = 'The transaction expired before it could land on chain. ' +
            'This happens when the wallet-confirm step takes longer than ~60 seconds. ' +
            '<strong>Nothing was moved.</strong> ' +
            'Refresh the page and try again — your wallet will prompt faster the second time.';
    } else if (m.startsWith('TIMEOUT') || ml.includes('did not confirm within') || ml.includes('took longer than 90 seconds')) {
      // We waited 90s for the chain to confirm; nothing landed in that
      // window. The tx might still confirm — but the user shouldn't
      // assume so without checking.
      msg = m.replace(/^TIMEOUT:\s*/, '');
    } else if (ml.includes('chain rejected')) {
      // pollForConfirmation saw an `err` field on the signature status.
      msg = escapeHtml(m);
    } else if (ml.includes('couldn\'t verify') || ml.includes('not enough')) {
      // Pre-flight checks (balance unknown / insufficient).
      msg = escapeHtml(m);
    } else {
      // Unknown error before broadcast (network blip, RPC failure, etc.)
      // The signature was never sent or never landed.
      msg = '<strong>Nothing was moved.</strong> An error occurred before the transaction could complete: ' + escapeHtml(m);
    }
    setStatus(msg, 'error');
  } finally {
    $('burnSubmit').disabled = false;
    burnState.signing = false;
  }
};

// Detect existing connection on load — populates the navbar #navWallet
// slot if Phantom/Solflare/etc. auto-connect to a previously-approved
// site, AND the inline form's submit button. burn.js is lazy-loaded so
// `load` may already have fired by the time we get here; fire one
// immediately AND once via setTimeout to catch slow wallet-extension
// injection (Phantom can take 1–2s).
refreshWalletState();
setTimeout(refreshWalletState, 800);
setTimeout(refreshWalletState, 2000);

// Seed the cost line + start a brief detection poller so the form is
// ready as soon as the user scrolls (or anchor-jumps) to it. Without
// these, the form would render with empty cost text and a stuck
// "Install a Solana wallet" button until an extension sneaks in.
// Initial paint: chip + bill of sale. Prices may not be fetched yet —
// recalculateBill is also called once prices resolve below.
renderBurnPayChip();
recalculateBill();
fetchAllPrices().then(recalculateBill).catch(() => {});
startWalletDetectPoller();

// Trigger the auto-suggest-take-#1 + snap-back-link plumbing exactly
// once at bootstrap. Without this, the burn-amount input sits empty
// until main.js's next tick fires (~30s after page load), because
// main.js's first tick runs BEFORE burn.js finishes loading and the
// optional chain `window.refreshBurnHint?.()` silently no-ops. Calling
// it ourselves here closes that race — the input is populated the
// moment burn.js is ready, whether or not the leaderboard data has
// landed yet. The bill is also re-rendered with the new value.
//
// Retry-capped: at most 50 attempts (5 seconds at 100ms intervals).
// If main.js's leaderboard module hasn't attached after 5s, something
// is broken — failing silent is better than a permanent spin loop.
function bootstrapAutoSuggest(remaining = 50) {
  if (window.__pyreLeaderboard?.minBurnToTakeTop) {
    refreshBurnHint();
    return;
  }
  if (remaining <= 0) return;
  setTimeout(() => bootstrapAutoSuggest(remaining - 1), 100);
}
bootstrapAutoSuggest();

// Initial bill paint when prices arrive — recalculateBill already
// renders, but the first call may have run before the price fetch
// resolved. Re-rendering once on price arrival closes the gap so
// the bill of sale never shows '—' for a few seconds after load.
