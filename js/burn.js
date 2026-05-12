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
// Solana libs are imported directly from esm.sh as ES modules.

import {
  Connection, PublicKey, Transaction, TransactionInstruction, SystemProgram, ComputeBudgetProgram,
  VersionedTransaction
} from 'https://esm.sh/@solana/web3.js@1.98.4';
import {
  createBurnCheckedInstruction, getAssociatedTokenAddressSync, getAccount,
  TOKEN_2022_PROGRAM_ID
} from 'https://esm.sh/@solana/spl-token@0.4.14';
// Solana Wallet Standard discovery — picks up Jupiter Mobile/Web, Glow,
// Magic Eden, OKX, Coinbase, Trust, Bitget, and modern Phantom/Solflare/
// Backpack via the standard's `register` event protocol instead of the
// legacy `window.solana` injection. Wrapped in try/catch at call-site so
// a CDN blip leaves the legacy window-global path working.
import { getWallets } from 'https://esm.sh/@wallet-standard/app@1.1.0';

import {
  PYRE_MINT_STR, RPC_URL, MEMO_PROGRAM_ID_STR, INSCRIPTION_BEACON_STR, isPlaceholder
} from './config.js';
import { $, shortAddr, escapeHtml, fmt } from './utils.js';
import { buildAtomicBurnTx, PAY_TOKENS } from './atomic-burn.js';

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

// Display-only cost estimate for the modal. Solana base fee is 5,000
// lamports per signature; we tack on a small priority fee for fast
// inclusion. Real fee is computed by the wallet at sign time.
const PRIORITY_LAMPORTS = 10_000;
const BASE_LAMPORTS     = 5_000;
const INSCRIPTION_LAMPORTS = 1; // transferred to the beacon as a marker
const TOTAL_LAMPORTS    = BASE_LAMPORTS + PRIORITY_LAMPORTS + INSCRIPTION_LAMPORTS;

// Live USD prices for the four tokens the bill of sale needs to value:
// SOL (network fee + alt pay path), $PYRE (service fee + leaderboard
// burn), USDC and USDT (alt pay paths). One round-trip per refresh.
// Cached for 60s so we don't re-fetch on every keystroke.
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const BILL_PRICE_MINTS = [SOL_MINT, PYRE_MINT_STR, PAY_TOKENS.usdc.mint, PAY_TOKENS.usdt.mint];
const JUP_PRICE_URL = 'https://lite-api.jup.ag/price/v3?ids=' + BILL_PRICE_MINTS.join(',');
const _priceCache = { ts: 0, prices: { sol: null, pyre: null, usdc: null, usdt: null } };
async function fetchAllPrices(){
  if (Date.now() - _priceCache.ts < 60_000 && _priceCache.prices.sol != null) {
    return _priceCache.prices;
  }
  try {
    const res = await fetch(JUP_PRICE_URL, { cache: 'no-store' });
    if (!res.ok) return _priceCache.prices;
    const data = await res.json();
    const sol  = data?.[SOL_MINT]?.usdPrice;
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
// Back-compat alias for any code path that still asks just for SOL/USD.
async function fetchSolPriceUsd(){
  const p = await fetchAllPrices();
  return p.sol;
}

// ─── STATE ───────────────────────────────────────────────────────────
const burnState = {
  provider: null,        // injected wallet provider (window.solana, etc.)
  publicKey: null,       // user's wallet pubkey (web3.PublicKey)
  decimals: null,        // PYRE mint's decimals, queried on connect
  balance: null,         // user's $PYRE balance (uiAmount)
  // Alt-pay balances. Each: { value: number | null }. null means
  // "we don't know yet" (haven't fetched, or RPC failed); 0 means
  // "fetched, account doesn't exist or holds nothing".
  solBalance: null,
  usdcBalance: null,
  usdtBalance: null,
  // Pay method — one of: 'pyre' | 'sol' | 'usdc' | 'usdt'. The
  // 'pyre' option uses the user's existing $PYRE balance (no swap);
  // the others use Jupiter to acquire-and-burn atomically.
  payMethod: 'sol',
  // Whether the user has manually edited the burn amount input. When
  // false, we auto-suggest min-to-take-#1 on every leaderboard tick.
  // Set true on any input event or X-clear click.
  userEditedAmount: false,
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

// Populate the form's "min burn to take #1" tip from the live
// leaderboard module (attached to window by main.js to avoid a
// dual-import of leaderboard.js — which would spawn a second
// _liveEntries state and double the leaderboard.json fetch).
// Exposed on window so main.js's tick() can refresh it on the same
// 30s cadence as the leaderboard data itself.
// Auto-prefill the burn amount with min-to-take-#1 IF the user hasn't
// manually edited the field yet. Runs on every leaderboard tick from
// main.js. The user's X-clear click also sets userEditedAmount=true so
// we don't fight them back to a non-zero number.
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
  if (!burnState.userEditedAmount) {
    const input = $('burnAmount');
    if (input && count > 0) {
      input.value = String(min);
    } else if (input && count === 0) {
      input.value = '1';
    }
  }
  if (hintEl) {
    if (count === 0) {
      hintEl.innerHTML = 'tip · the pyre is cold — any burn takes #1.';
    } else {
      hintEl.innerHTML = `tip · burn <strong>&ge; ${escapeHtml(fmt(min))} $PYRE</strong> right now to take #1.`;
    }
  }
  recalculateBill();
}
window.refreshBurnHint = refreshBurnHint;

// Live message char counter + bill of sale re-render.
document.addEventListener('input', e => {
  if (e.target.id === 'burnMsg') {
    const el = $('msgCount');
    if (el) el.textContent = e.target.value.length;
  }
  if (e.target.id === 'burnAmount') {
    burnState.userEditedAmount = true;
    recalculateBill();
  }
});

// ─── BILL OF SALE ─────────────────────────────────────────────────
// Renders the itemized cost breakdown beneath the form: Solana fee,
// service fee (1 $PYRE buy+burn), leaderboard burn (N $PYRE buy+burn),
// and the bottom-line "you pay" total in both USD and the chosen
// pay-with token. Re-runs on every input change, every leaderboard
// tick, every payMethod switch, and every price refresh.
function fmtBillUsd(usd) {
  if (!isFinite(usd) || usd <= 0) return '~$0';
  if (usd >= 1000) return '~$' + Math.round(usd).toLocaleString();
  if (usd >= 1)    return '~$' + usd.toFixed(2);
  if (usd >= 0.01) return '~$' + usd.toFixed(3);
  if (usd >= 0.0001) return '~$' + usd.toFixed(5);
  return '~$' + usd.toFixed(7);
}
function fmtPayAmount(amount, decimals, symbol) {
  if (!isFinite(amount) || amount <= 0) return `&approx; 0 ${symbol}`;
  const dp = decimals === 9 ? 6 : 4;
  const s = amount.toFixed(dp).replace(/0+$/, '').replace(/\.$/, '');
  return `&approx; ${s} ${symbol}`;
}
function recalculateBill() {
  const billEl = $('burnBill');
  if (!billEl) return;
  const rawAmt = parseFloat($('burnAmount')?.value);
  const leaderboardAmt = (Number.isFinite(rawAmt) && rawAmt > 0) ? rawAmt : 0;
  const totalBurnAmt = SERVICE_FEE_PYRE + leaderboardAmt; // always at least the service fee
  const prices = _priceCache.prices;
  const solFeeSol = TOTAL_LAMPORTS / 1e9;
  const solFeeUsd = prices.sol != null ? solFeeSol * prices.sol : null;
  const serviceUsd = prices.pyre != null ? SERVICE_FEE_PYRE * prices.pyre : null;
  const lbUsd = prices.pyre != null ? leaderboardAmt * prices.pyre : null;
  const totalUsd = (solFeeUsd ?? 0) + (serviceUsd ?? 0) + (lbUsd ?? 0);

  // ── Each line item ──
  $('burnBillSolFee').textContent = solFeeUsd != null ? fmtBillUsd(solFeeUsd) : '—';
  $('burnBillService').textContent = serviceUsd != null ? fmtBillUsd(serviceUsd) : '—';
  const lbRow = $('burnBillLeaderboardRow');
  if (leaderboardAmt > 0) {
    lbRow.hidden = false;
    $('burnBillBurnAmt').textContent = fmt(leaderboardAmt);
    $('burnBillLeaderboard').textContent = lbUsd != null ? fmtBillUsd(lbUsd) : '—';
  } else {
    lbRow.hidden = true;
  }

  // ── Total in USD + pay-with-token equivalent ──
  $('burnBillTotalUsd').textContent = totalUsd > 0 ? fmtBillUsd(totalUsd) : '—';

  // Compute the pay-with-token amount. If 'pyre' is the pay method,
  // there's no swap — show just the $PYRE-burned total and the SOL fee
  // separately. For SOL/USDC/USDT we add the SOL network fee + the
  // swap cost (USD value / token price).
  const payTok = burnState.payMethod;
  const totalPayEl = $('burnBillTotalPay');
  if (payTok === 'pyre') {
    // The user pays SOL for network fees + (1 + N) $PYRE from balance.
    const pyreTotal = totalBurnAmt;
    totalPayEl.innerHTML = `&approx; ${fmt(pyreTotal)} $PYRE + ${solFeeSol.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} SOL fee`;
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
        ? ` + ${(solFeeUsd / prices.sol).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} SOL fee`
        : '';
      totalPayEl.innerHTML = fmtPayAmount(tokAmount, dec, sym) + extra;
    }
  }

  // Submit button label — describes the action precisely.
  const btn = $('burnSubmit');
  if (btn && !btn.disabled && burnState.publicKey) {
    btn.textContent = totalBurnAmt > 1
      ? `Burn ${fmt(totalBurnAmt)} $PYRE & inscribe`
      : `Burn 1 $PYRE & inscribe`;
  }
}

// ─── WALLET DETECTION ────────────────────────────────────────────────
// Two-layer detection: Solana Wallet Standard first (Jupiter, Glow,
// Magic Eden, modern Phantom/Solflare/Backpack/etc.), then legacy
// window.solana / window.solflare / window.backpack injection as a
// fallback for older wallets that haven't migrated to the standard.
//
// Standard wallets are wrapped in an adapter object that exposes the
// same { publicKey, isConnected, connect, signTransaction } API as the
// legacy Phantom-style provider, so the rest of this file is unchanged.

const _standardRegistry = {
  inited: false,
  wallets: [],        // adapted Solana wallets discovered via Wallet Standard
  selectedName: null, // user's wallet-picker choice (persisted in localStorage)
};

// localStorage key for the user's wallet pick. Survives reloads so a
// user who explicitly chose "Jupiter" doesn't get bounced back to
// Phantom on the next visit.
const WALLET_PICK_KEY = 'pyre.walletPick';

function isSolanaStandardWallet(w) {
  // Solana support is signalled by either the chains list or by the
  // presence of solana:* features. We accept either — some wallets
  // (e.g. multi-chain ones) leave `chains` empty until connected.
  const isSolanaChain = (c) => typeof c === 'string' && c.startsWith('solana:');
  if (Array.isArray(w.chains) && w.chains.some(isSolanaChain)) return true;
  const f = w.features;
  if (f && (f['solana:signTransaction'] || f['solana:signAndSendTransaction'])) return true;
  return false;
}

function adaptStandardWallet(w) {
  // Wraps a Wallet-Standard wallet to look like a legacy Phantom-style
  // provider. The legacy API the rest of burn.js uses:
  //   provider.publicKey                   → PublicKey | null
  //   provider.isConnected                 → boolean
  //   provider.connect()                   → Promise<void>
  //   provider.signTransaction(tx)         → Promise<Transaction>
  return {
    _isStandard: true,
    _wallet: w,
    name: w.name,
    icon: w.icon,
    get publicKey() {
      const acct = w.accounts?.[0];
      try { return acct ? new PublicKey(acct.address) : null; }
      catch { return null; }
    },
    get isConnected() {
      return Array.isArray(w.accounts) && w.accounts.length > 0;
    },
    async connect() {
      const feat = w.features?.['standard:connect'];
      if (!feat) throw new Error(`${w.name} does not expose standard:connect`);
      await feat.connect();
    },
    async signTransaction(tx) {
      const feat = w.features?.['solana:signTransaction'];
      if (!feat) throw new Error(`${w.name} does not expose solana:signTransaction`);
      const acct = w.accounts?.[0];
      if (!acct) throw new Error(`No connected account on ${w.name} — connect first`);
      // Wallet Standard wants the wire bytes (unsigned), not a Transaction
      // object. requireAllSignatures/verifySignatures false because the
      // user's signature is exactly what we're asking the wallet to add.
      const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const results = await feat.signTransaction({
        transaction: serialized,
        account: acct,
        chain: 'solana:mainnet',
      });
      const signedBytes = results?.[0]?.signedTransaction;
      if (!signedBytes) throw new Error(`${w.name} returned no signed transaction`);
      return Transaction.from(signedBytes);
    },
  };
}

function initStandardRegistry() {
  if (_standardRegistry.inited) return;
  _standardRegistry.inited = true;
  try {
    const api = getWallets();
    const refresh = () => {
      _standardRegistry.wallets = api.get()
        .filter(isSolanaStandardWallet)
        .map(adaptStandardWallet);
      // Late wallet registration is the common case (extensions inject
      // after our module loads). Re-render the inline form whenever a
      // wallet appears so the user doesn't have to reload the page to
      // see the new wallet in the picker.
      refreshWalletState();
    };
    refresh();
    api.on('register', refresh);
    api.on('unregister', refresh);
    try {
      _standardRegistry.selectedName = localStorage.getItem(WALLET_PICK_KEY);
    } catch { /* localStorage disabled — fine, we just won't persist */ }
  } catch (e) {
    console.warn('Wallet Standard init failed; falling back to window globals only:', e);
  }
}
initStandardRegistry();

// The "late wallet registration" callback above (in `refresh()`) used to
// re-render only when the modal was open. With the form always in the
// DOM, the inline copy of that re-render is unconditional — see the
// refreshWalletState() call wired to the standard registry's refresh
// callback below.

function detectLegacyProvider() {
  // Pre-Wallet-Standard injection points. Kept for older wallet versions.
  if (window.solana && window.solana.isPhantom) return Object.assign(window.solana, { name: window.solana.name || 'Phantom' });
  if (window.phantom?.solana) return Object.assign(window.phantom.solana, { name: 'Phantom' });
  if (window.solflare && window.solflare.isSolflare) return Object.assign(window.solflare, { name: 'Solflare' });
  if (window.backpack) return Object.assign(window.backpack, { name: 'Backpack' });
  if (window.solana) return Object.assign(window.solana, { name: window.solana.name || 'Solana wallet' });
  return null;
}

function detectAllProviders() {
  // Standard wallets first (they're the modern path); then legacy
  // injection, deduped by name so a wallet that supports both paths
  // doesn't appear twice in the picker.
  const out = [..._standardRegistry.wallets];
  const haveNames = new Set(out.map(w => (w.name || '').toLowerCase()));
  const legacy = detectLegacyProvider();
  if (legacy && !haveNames.has((legacy.name || '').toLowerCase())) {
    out.push(legacy);
  }
  return out;
}

function detectProvider() {
  const all = detectAllProviders();
  if (all.length === 0) return null;
  if (_standardRegistry.selectedName) {
    const picked = all.find(w => (w.name || '').toLowerCase() === _standardRegistry.selectedName.toLowerCase());
    if (picked) return picked;
  }
  return all[0];
}

window.__pyrePickWallet = function pickWallet(name) {
  _standardRegistry.selectedName = name || null;
  try {
    if (name) localStorage.setItem(WALLET_PICK_KEY, name);
    else localStorage.removeItem(WALLET_PICK_KEY);
  } catch { /* localStorage disabled — keep in-memory pick only */ }
  refreshWalletState();
};

function renderWalletPickerLine(all, active) {
  // When more than one wallet is available, render a small switcher
  // line so the user can pick between e.g. Phantom and Jupiter. Single-
  // wallet case shows just the active wallet's name (no need to switch).
  if (!all || all.length <= 1) {
    return active?.name ? `<span class="wallet-name">via ${escapeHtml(active.name)}</span>` : '';
  }
  const opts = all.map(w => {
    const n = escapeHtml(w.name || 'wallet');
    const sel = (active && (w.name || '').toLowerCase() === (active.name || '').toLowerCase()) ? ' selected' : '';
    return `<option value="${n}"${sel}>${n}</option>`;
  }).join('');
  return `<span class="wallet-name">via </span>` +
         `<select class="wallet-picker" ` +
         `onchange="window.__pyrePickWallet(this.value)" ` +
         `aria-label="Choose wallet">${opts}</select>`;
}

async function refreshWalletState() {
  const all = detectAllProviders();
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
    const pickerHtml = renderWalletPickerLine(all, provider);
    if (navSlot) {
      navSlot.innerHTML =
        `<span class="wallet-badge"><span class="wallet-addr" title="${escapeHtml(addr)}">${escapeHtml(shortAddr(addr))}</span> ${pickerHtml}` +
        `<button type="button" class="wallet-disconnect" onclick="window.__pyreDisconnectWallet()" aria-label="Disconnect wallet" title="Disconnect">×</button></span>`;
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

window.__pyreDisconnectWallet = async function disconnectWallet(){
  const p = burnState.provider;
  if (p && typeof p.disconnect === 'function') {
    try { await p.disconnect(); } catch (_) { /* some wallets throw on already-disconnected; ignore */ }
  }
  // Wallet Standard wallets disconnect via the feature endpoint.
  if (p?._isStandard) {
    const feat = p._wallet?.features?.['standard:disconnect'];
    if (feat) { try { await feat.disconnect(); } catch (_) {} }
  }
  burnState.publicKey = null;
  burnState.balance = null;
  refreshWalletState();
};

function _submitLabel(){
  // Every inscription always burns at least the service fee. The label
  // reflects total burn (service fee + optional leaderboard amount).
  const amt = parseFloat($('burnAmount')?.value);
  const lb = (Number.isFinite(amt) && amt > 0) ? amt : 0;
  const total = SERVICE_FEE_PYRE + lb;
  return `Burn ${fmt(total)} $PYRE & inscribe`;
}

// X clear button — sets burn amount to 0 and marks the user has
// edited the field (so auto-prefill won't pull them back to the
// take-#1 suggestion on the next leaderboard tick). The 1 $PYRE
// service fee still applies; this just zeros out the OPTIONAL
// leaderboard layer on top.
document.addEventListener('click', e => {
  const clearBtn = e.target.closest('#burnAmountClear');
  if (clearBtn) {
    e.preventDefault();
    const input = $('burnAmount');
    if (input) {
      input.value = '0';
      burnState.userEditedAmount = true;
      recalculateBill();
      input.focus();
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
  // Pay-with option click
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

// pump.fun mints SPL tokens under the Token-2022 program (NOT the
// legacy Token program). This matters for THREE places: ATA address
// derivation, getAccount() reading, and transfer/ATA-creation
// instructions. If we use legacy defaults the ATA address is wrong
// and balance reads as 0 even when the user holds the token.
const TOKEN_PROGRAM = TOKEN_2022_PROGRAM_ID;

async function refreshBalance() {
  if (!burnState.publicKey) return;
  if (isPlaceholder()) return;
  try {
    const conn = new Connection(RPC_URL, 'confirmed');
    const mint = new PublicKey(PYRE_MINT_STR);
    const ata = getAssociatedTokenAddressSync(mint, burnState.publicKey, false, TOKEN_PROGRAM);
    const acct = await getAccount(conn, ata, undefined, TOKEN_PROGRAM);
    if (burnState.decimals === null) {
      const mintInfo = await conn.getParsedAccountInfo(mint);
      burnState.decimals = mintInfo.value.data.parsed.info.decimals;
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

  // Read content fields. At least one of msg/url/xh is required — the
  // 1 $PYRE service fee alone isn't a reason to inscribe (otherwise
  // every page reload could spam an empty memo into the wall).
  const rawUrl = $('burnUrl')?.value || '';
  const url    = rawUrl.trim() ? normalizeBurnUrl(rawUrl) : '';
  if (rawUrl.trim() && !url) {
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
    setStatus('Add a message, a URL, or an X handle — at least one is required.', 'error');
    return;
  }
  if (msg.includes('|') || (url && url.includes('|')) || xh.includes('|')) {
    setStatus('The <code>|</code> character is reserved (used as the memo separator). Pick another.', 'error');
    return;
  }
  if (xh && !X_HANDLE_RE.test(xh)) {
    setStatus('X handle should be 1–15 letters, numbers, or underscores. Drop the @ — we add it back.', 'error');
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

    const conn = new Connection(RPC_URL, 'confirmed');
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
        const mintInfo = await conn.getParsedAccountInfo(mint);
        burnState.decimals = mintInfo.value.data.parsed.info.decimals;
      }
      const senderAta = getAssociatedTokenAddressSync(mint, sender, false, TOKEN_PROGRAM);
      const rawAmount = BigInt(Math.floor(totalBurnAmt * 10 ** burnState.decimals));
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
        lamports: INSCRIPTION_LAMPORTS,
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
      setStatus('Quoting Jupiter swap…', 'info');
      const built = await buildAtomicBurnTx({
        conn,
        payer: sender,
        payMint,
        totalBurnAmt,
        memoText,
      });
      // Hard cap: Solana txs are 1232 bytes max. If Jupiter's route is
      // too dense to fit alongside the burn+memo+beacon, surface a
      // clear error — the user can try a different pay token or smaller
      // burn amount. (Two-tx fallback is a future enhancement; for now
      // we refuse oversize to keep atomicity airtight.)
      if (built.sizeBytes > 1232) {
        throw new Error(
          'Route too dense to fit in one transaction (' + built.sizeBytes + ' bytes, max 1232). ' +
          'Try a smaller burn amount or a different pay-with token.'
        );
      }
      tx = built.tx;
      lastValidBlockHeight = built.lastValidBlockHeight;
    }

    setStatus('Confirm in your wallet…', 'info');

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
      '<a href="https://solscan.io/tx/' + signature + '" target="_blank">' + shortAddr(signature) + ' ↗</a>', 'info');

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
      '<a href="https://solscan.io/tx/' + signature + '" target="_blank">View transaction ↗</a>',
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
