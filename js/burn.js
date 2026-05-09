// ─── BURN BUTTON ─────────────────────────────────────────────────────
// Wallet integration via window.solana. Builds a Token-2022 BurnChecked
// instruction + Memo Program instruction, signs through the user's wallet
// (Phantom/Solflare/Backpack), and sends to mainnet.
//
// Why BurnChecked, not transfer-to-null: protocol-level burns actually
// destroy tokens — the mint's total supply decreases by the burned
// amount, every aggregator (Jupiter, DexScreener, Birdeye, Solscan)
// reflects the reduction, and the deflationary claim becomes verifiable
// from any indexer rather than only from our leaderboard. Transfer-to-
// null would relocate the tokens to the system program's ATA but leave
// supply unchanged.
//
// We import Solana libs directly from esm.sh as ES modules. This means
// (a) no window globals to race against, (b) any function in this file
// can use the imported symbols immediately because top-level await on
// the imports has already resolved by the time the module body runs.

import {
  Connection, PublicKey, Transaction, TransactionInstruction
} from 'https://esm.sh/@solana/web3.js@1.95.4';
import {
  createBurnCheckedInstruction, getAssociatedTokenAddressSync, getAccount,
  TOKEN_2022_PROGRAM_ID
} from 'https://esm.sh/@solana/spl-token@0.4.8';

import {
  PYRE_MINT_STR, RPC_URL, MEMO_PROGRAM_ID_STR, isPlaceholder
} from './config.js';
import { $, shortAddr, escapeHtml } from './utils.js';

// ─── STATE ───────────────────────────────────────────────────────────
const burnState = {
  provider: null,        // injected wallet provider (window.solana, etc.)
  publicKey: null,       // user's wallet pubkey (web3.PublicKey)
  decimals: null,        // mint's decimals, queried on connect
  balance: null,         // user's $PYRE balance
};

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
// after DOMContentLoaded. Without re-detection on modal open + a brief
// retry window, slow extensions leave the modal stuck on
// "Wallet: none detected" until the page is reloaded.
let _walletDetectPoller = null;
function stopWalletDetectPoller(){
  if (_walletDetectPoller){ clearInterval(_walletDetectPoller); _walletDetectPoller = null; }
}

window.openBurnModal = function() {
  $('burnModal').classList.add('open');
  document.body.style.overflow = 'hidden';
  refreshWalletState();
  stopWalletDetectPoller();
  let retries = 8; // ~2s at 250ms intervals
  _walletDetectPoller = setInterval(() => {
    if (detectProvider() || --retries <= 0) {
      stopWalletDetectPoller();
      refreshWalletState();
    }
  }, 250);
};
window.closeBurnModal = function() {
  stopWalletDetectPoller();
  $('burnModal').classList.remove('open');
  document.body.style.overflow = '';
  clearStatus();
};

// Live message char counter
document.addEventListener('input', e => {
  if (e.target.id === 'burnMsg') $('msgCount').textContent = e.target.value.length;
});

// Click-outside-to-close — but only if the pointer goes DOWN and UP on
// the backdrop itself. The previous inline `onclick` handler closed
// the modal on any click event whose target was the backdrop, which
// included the case where a user mousedown'd on a form field, dragged
// to select text, and released outside the modal — closing it
// mid-selection. This pattern preserves text-selection inside the
// modal while still closing on a clean outside click.
(function wireBackdropDismiss() {
  const backdrop = $('burnModal');
  if (!backdrop) return;
  let pointerDownOnBackdrop = false;
  backdrop.addEventListener('pointerdown', (e) => {
    pointerDownOnBackdrop = (e.target === backdrop);
  });
  backdrop.addEventListener('pointerup', (e) => {
    if (pointerDownOnBackdrop && e.target === backdrop) {
      closeBurnModal();
    }
    pointerDownOnBackdrop = false;
  });
  // Reset state if the pointer is cancelled (e.g., drag becomes a
  // browser gesture). Without this, a stray cancel could leave the
  // flag set and a subsequent legitimate click misbehave.
  backdrop.addEventListener('pointercancel', () => { pointerDownOnBackdrop = false; });
})();

// ─── WALLET DETECTION ────────────────────────────────────────────────
function detectProvider() {
  // Phantom, Solflare, Backpack all inject into window.solana.
  // Solflare also injects window.solflare; Backpack injects window.backpack.
  if (window.solana && window.solana.isPhantom) return window.solana;
  if (window.phantom?.solana) return window.phantom.solana;
  if (window.solflare && window.solflare.isSolflare) return window.solflare;
  if (window.backpack) return window.backpack;
  if (window.solana) return window.solana; // generic fallback
  return null;
}

async function refreshWalletState() {
  const provider = detectProvider();
  if (!provider) {
    $('walletStatus').innerHTML = 'Wallet: <span style="color:var(--text2)">none detected</span>';
    $('walletBalance').textContent = '';
    $('burnSubmit').textContent = 'Install a Solana wallet';
    $('burnSubmit').disabled = true;
    return;
  }
  burnState.provider = provider;
  if (provider.publicKey) {
    burnState.publicKey = provider.publicKey;
    $('walletStatus').innerHTML = 'Wallet: <span class="connected">' + shortAddr(provider.publicKey.toString()) + '</span>';
    $('burnSubmit').textContent = 'Burn $PYRE';
    $('burnSubmit').disabled = false;
    await refreshBalance();
  } else {
    $('walletStatus').innerHTML = 'Wallet: <span style="color:var(--text2)">not connected</span>';
    $('walletBalance').textContent = '';
    $('burnSubmit').textContent = 'Connect wallet & burn';
    $('burnSubmit').disabled = false;
  }
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
    const ui = Number(acct.amount) / 10 ** burnState.decimals;
    burnState.balance = ui;
    $('walletBalance').textContent = ui.toLocaleString(undefined,{maximumFractionDigits:2}) + ' $PYRE';
  } catch (e) {
    // Distinguish 'no token account' (= balance is genuinely 0) from
    // RPC/network failure (= balance unknown). The submitBurn check
    // below relies on the distinction: amt > 0 burn against unknown
    // balance MUST be refused, not silently accepted.
    if (e?.name === 'TokenAccountNotFoundError') {
      $('walletBalance').textContent = '0 $PYRE';
      burnState.balance = 0;
    } else {
      $('walletBalance').textContent = 'balance unknown';
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
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return null; // no IP-literal URLs (per project-policy §3)
    return stripped;
  } catch { return null; }
}

// ─── BURN SUBMISSION ─────────────────────────────────────────────────
window.submitBurn = async function submitBurn() {
  clearStatus();
  if (isPlaceholder()) {
    setStatus('$PYRE has not launched yet. The burn button activates once the token mint is configured.', 'error');
    return;
  }

  const rawUrl = $('burnUrl').value;
  const url = normalizeBurnUrl(rawUrl);
  const msg = $('burnMsg').value.trim();
  const amt = parseFloat($('burnAmount').value);

  if (!url) {
    setStatus('That URL doesn\'t look right — try something like <code>yoursite.xyz</code> (no spaces, no <code>|</code>).', 'error');
    return;
  }
  if (!msg || !amt || amt <= 0) {
    setStatus('Fill the message and a positive amount.', 'error');
    return;
  }
  if (msg.includes('|')) {
    setStatus('The <code>|</code> character is reserved (used as the memo separator). Pick another.', 'error');
    return;
  }

  const provider = detectProvider();
  if (!provider) {
    setStatus('No Solana wallet found. Install <a href="https://phantom.app" target="_blank">Phantom</a> or <a href="https://solflare.com" target="_blank">Solflare</a>.', 'error');
    return;
  }

  $('burnSubmit').disabled = true;
  setStatus('Connecting wallet…', 'info');

  try {
    if (!provider.isConnected) await provider.connect();
    burnState.provider = provider;
    burnState.publicKey = provider.publicKey;
    await refreshBalance();

    if (burnState.balance === null) {
      throw new Error('Couldn\'t verify your $PYRE balance (RPC failed). Try again in a moment.');
    }
    if (amt > burnState.balance) {
      throw new Error('You only have ' + burnState.balance.toLocaleString() + ' $PYRE — not enough for this burn.');
    }

    setStatus('Building transaction…', 'info');

    const conn = new Connection(RPC_URL, 'confirmed');
    const mint = new PublicKey(PYRE_MINT_STR);
    const sender = burnState.publicKey;

    if (burnState.decimals === null) {
      const mintInfo = await conn.getParsedAccountInfo(mint);
      burnState.decimals = mintInfo.value.data.parsed.info.decimals;
    }

    const senderAta = getAssociatedTokenAddressSync(mint, sender, false, TOKEN_PROGRAM);

    // Native Token-2022 burn: destroys the tokens at the protocol layer.
    // No destination ATA, no rent. Mint supply decreases by `rawAmount`.
    const rawAmount = BigInt(Math.floor(amt * 10 ** burnState.decimals));
    const tx = new Transaction();
    tx.add(createBurnCheckedInstruction(
      senderAta, mint, sender, rawAmount, burnState.decimals, [], TOKEN_PROGRAM
    ));

    const memoText = 'url=' + url + ' | msg=' + msg;
    tx.add(new TransactionInstruction({
      keys: [{ pubkey: sender, isSigner: true, isWritable: false }],
      programId: new PublicKey(MEMO_PROGRAM_ID_STR),
      data: new TextEncoder().encode(memoText),
    }));

    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = sender;

    setStatus('Confirm in your wallet…', 'info');
    const { signature } = await provider.signAndSendTransaction(tx);

    setStatus('Submitted. Waiting for confirmation…<br>' +
      '<a href="https://solscan.io/tx/' + signature + '" target="_blank">' + shortAddr(signature) + ' ↗</a>', 'info');

    await conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');

    setStatus('🔥 Burned. Your slot will appear on the leaderboard within ~10 minutes once the indexer picks it up.<br>' +
      '<a href="https://solscan.io/tx/' + signature + '" target="_blank">View transaction ↗</a>', 'success');
    await refreshBalance();
  } catch (err) {
    const m = err?.message || String(err);
    if (m.toLowerCase().includes('user rejected')) {
      setStatus('Transaction rejected in wallet.', 'error');
    } else {
      setStatus('Error: ' + escapeHtml(m), 'error');
    }
  } finally {
    $('burnSubmit').disabled = false;
  }
};

// Try to detect existing connection on load (auto-connected wallets)
window.addEventListener('load', () => {
  setTimeout(refreshWalletState, 800);
});

// If main.js's bootstrap stub already opened the modal before this module
// finished loading, finish the wiring now (populate wallet status + balance).
if ($('burnModal') && $('burnModal').classList.contains('open')) {
  refreshWalletState();
}
