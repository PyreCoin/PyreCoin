// ─── SHARED WALLET ADAPTER ──────────────────────────────────────────
// Single source of truth for wallet discovery, selection, signing,
// and disconnect. Used by burn.js (legacy Transaction) and buy.js
// (VersionedTransaction). Same Wallet Standard discovery in both
// places — no duplicate state, no two-copies-of-getWallets() drift.
//
// Layered detection:
//   1. Solana Wallet Standard (Jupiter Mobile/Web, Glow, Magic Eden,
//      OKX, Coinbase, Trust, Bitget, modern Phantom/Solflare/Backpack).
//   2. Legacy window.solana / window.solflare / window.backpack
//      injection (older wallet versions).
// Standard wallets are wrapped in an adapter object that exposes the
// same { publicKey, isConnected, connect, signTransaction } API as
// the legacy Phantom-style provider, so call sites are uniform.
//
// signTransaction is type-aware: detects VersionedTransaction vs
// legacy Transaction by `tx.version`, serializes appropriately, and
// returns the same type signed.

import {
  Transaction, VersionedTransaction, PublicKey
} from 'https://esm.sh/@solana/web3.js@1.95.4';
import { getWallets } from 'https://esm.sh/@wallet-standard/app@1.1.0';

// localStorage key for the user's wallet pick. Survives reloads so a
// user who explicitly chose "Jupiter" doesn't get bounced back to
// Phantom on the next visit.
const WALLET_PICK_KEY = 'pyre.walletPick';
const SOLANA_CHAIN = 'solana:mainnet';

const _registry = {
  inited: false,
  wallets: [],
  selectedName: null,
};

const _listeners = new Set();
function notifyChange() {
  for (const cb of _listeners) {
    try { cb(); } catch (e) { console.error('wallet listener failed:', e); }
  }
}

// Subscribe to wallet state changes (register/unregister, pick, disconnect).
// Returns an unsubscribe function. Call the returned function to remove the
// listener — typically not needed since listeners live for the page session.
export function onWalletChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

function isSolanaStandardWallet(w) {
  // Solana support is signalled by either the chains list or by the
  // presence of solana:* features. Accept either — some wallets
  // (e.g. multi-chain ones) leave `chains` empty until connected.
  const isSolanaChain = (c) => typeof c === 'string' && c.startsWith('solana:');
  if (Array.isArray(w.chains) && w.chains.some(isSolanaChain)) return true;
  const f = w.features;
  if (f && (f['solana:signTransaction'] || f['solana:signAndSendTransaction'])) return true;
  return false;
}

function adaptStandardWallet(w) {
  // Wraps a Wallet-Standard wallet to look like a legacy Phantom-style
  // provider. The legacy API the rest of the codebase uses:
  //   provider.publicKey                   → PublicKey | null
  //   provider.isConnected                 → boolean
  //   provider.connect()                   → Promise<void>
  //   provider.signTransaction(tx)         → Promise<Tx>   (same type in)
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
      // VersionedTransaction has a `.version` field; legacy Transaction
      // does not. Serialize accordingly — legacy needs the unsigned-
      // serialize options, v0 takes no options. The Wallet Standard
      // feature returns the signed wire bytes either way; we re-
      // deserialize back into the same type that came in.
      const isVersioned = typeof tx.version !== 'undefined';
      const serialized = isVersioned
        ? tx.serialize()
        : tx.serialize({ requireAllSignatures: false, verifySignatures: false });
      const results = await feat.signTransaction({
        transaction: serialized,
        account: acct,
        chain: SOLANA_CHAIN,
      });
      const signedBytes = results?.[0]?.signedTransaction;
      if (!signedBytes) throw new Error(`${w.name} returned no signed transaction`);
      return isVersioned
        ? VersionedTransaction.deserialize(signedBytes)
        : Transaction.from(signedBytes);
    },
  };
}

function initStandardRegistry() {
  if (_registry.inited) return;
  _registry.inited = true;
  try {
    const api = getWallets();
    const refresh = () => {
      _registry.wallets = api.get()
        .filter(isSolanaStandardWallet)
        .map(adaptStandardWallet);
      // Late wallet registration is the common case (extensions inject
      // after our module loads). Notify subscribers so their UIs can
      // re-render without a page reload.
      notifyChange();
    };
    refresh();
    api.on('register', refresh);
    api.on('unregister', refresh);
    try {
      _registry.selectedName = localStorage.getItem(WALLET_PICK_KEY);
    } catch { /* localStorage disabled — fine, we just won't persist */ }
  } catch (e) {
    console.warn('Wallet Standard init failed; falling back to window globals only:', e);
  }
}
initStandardRegistry();

function detectLegacyProvider() {
  // Pre-Wallet-Standard injection points. Kept for older wallet versions.
  if (window.solana && window.solana.isPhantom) return Object.assign(window.solana, { name: window.solana.name || 'Phantom' });
  if (window.phantom?.solana) return Object.assign(window.phantom.solana, { name: 'Phantom' });
  if (window.solflare && window.solflare.isSolflare) return Object.assign(window.solflare, { name: 'Solflare' });
  if (window.backpack) return Object.assign(window.backpack, { name: 'Backpack' });
  if (window.solana) return Object.assign(window.solana, { name: window.solana.name || 'Solana wallet' });
  return null;
}

export function detectAllProviders() {
  // Standard wallets first (modern path); then legacy injection, deduped
  // by name so a wallet that supports both paths doesn't appear twice.
  const out = [..._registry.wallets];
  const haveNames = new Set(out.map(w => (w.name || '').toLowerCase()));
  const legacy = detectLegacyProvider();
  if (legacy && !haveNames.has((legacy.name || '').toLowerCase())) {
    out.push(legacy);
  }
  return out;
}

export function detectProvider() {
  const all = detectAllProviders();
  if (all.length === 0) return null;
  if (_registry.selectedName) {
    const picked = all.find(w => (w.name || '').toLowerCase() === _registry.selectedName.toLowerCase());
    if (picked) return picked;
  }
  return all[0];
}

export function pickWallet(name) {
  _registry.selectedName = name || null;
  try {
    if (name) localStorage.setItem(WALLET_PICK_KEY, name);
    else localStorage.removeItem(WALLET_PICK_KEY);
  } catch { /* localStorage disabled — keep in-memory pick only */ }
  notifyChange();
}

export async function disconnectWallet() {
  const p = detectProvider();
  if (!p) return;
  if (typeof p.disconnect === 'function') {
    try { await p.disconnect(); } catch (_) { /* some wallets throw on already-disconnected; ignore */ }
  }
  if (p._isStandard) {
    const feat = p._wallet?.features?.['standard:disconnect'];
    if (feat) { try { await feat.disconnect(); } catch (_) {} }
  }
  notifyChange();
}

// Legacy onclick handlers in burn.js (rendered inline into the nav slot
// HTML string) still reference these globals. Keep them exposed so the
// existing markup keeps working.
window.__pyrePickWallet = pickWallet;
window.__pyreDisconnectWallet = disconnectWallet;
