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
import { $, shortAddr, escapeHtml, fmt } from './utils.js';

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
  refreshBurnHint();
  stopWalletDetectPoller();
  let retries = 8; // ~2s at 250ms intervals
  _walletDetectPoller = setInterval(() => {
    if (detectProvider() || --retries <= 0) {
      stopWalletDetectPoller();
      refreshWalletState();
    }
  }, 250);
};

// Populate the modal's "min burn to take #1" tip from the live
// leaderboard module (attached to window by main.js to avoid a
// dual-import of leaderboard.js — which would spawn a second
// _liveEntries state and double the leaderboard.json fetch).
function refreshBurnHint() {
  const el = $('burnHint');
  if (!el) return;
  const lb = window.__pyreLeaderboard;
  if (!lb || typeof lb.minBurnToTakeTop !== 'function') {
    el.innerHTML = '';
    return;
  }
  const min = lb.minBurnToTakeTop(new Date());
  const count = (typeof lb.liveEntryCount === 'function') ? lb.liveEntryCount() : 0;
  if (count === 0) {
    el.innerHTML = 'tip · the pyre is cold — any burn takes #1.';
  } else {
    el.innerHTML = `tip · burn <strong>≥ ${escapeHtml(fmt(min))} $PYRE</strong> right now to take #1.`;
  }
}
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
  // The wallet-row strip carries the "Wallet: <addr>" / "Wallet: not
  // connected" status line. When NO provider is detected at all, the
  // big orange "Install a Solana wallet" submit button is the only
  // call to action that matters — the redundant status line eats
  // valuable modal real estate, so we hide the entire row.
  const walletRow = $('walletStatus')?.parentElement;
  if (!provider) {
    if (walletRow) walletRow.style.display = 'none';
    $('walletStatus').innerHTML = '';
    $('walletBalance').textContent = '';
    $('burnSubmit').textContent = 'Install a Solana wallet';
    $('burnSubmit').disabled = true;
    return;
  }
  if (walletRow) walletRow.style.display = '';
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
        'The chain rejected the burn — your tokens are safe and were not moved. ' +
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
            'Your tokens are safe — no burn was executed.'
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
    'It may still land — check the Solscan link. Your tokens are safe ' +
    'unless Solscan shows the burn instruction confirmed in a block.'
  );
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

    setStatus('Confirm in your wallet…', 'info');

    // Use the freshest blockhash possible ('processed' commitment returns
    // the newest one our RPC has seen). The 150-slot (~60s) validity
    // window starts ticking from blockhash creation; every saved slot
    // here is a slot the user gets to spend reading Phantom's prompt.
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('processed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = sender;

    // Sign-only via the wallet, then broadcast ourselves with retries.
    // signAndSendTransaction goes through the wallet's RPC and gives no
    // retry control — if the user takes 30+s in Phantom's prompt and the
    // blockhash drifts close to its expiry, a single-shot broadcast can
    // be rejected by the leader as "BlockhashNotFound" and silently drop.
    // signTransaction + our sendRawTransaction(maxRetries:10) re-submits
    // the same signed tx until it lands; the chain de-dupes by signature
    // so retries are safe (no double-burn risk).
    if (!provider.signTransaction) {
      throw new Error('Your wallet does not expose signTransaction. Use Phantom, Solflare, or Backpack.');
    }
    const signedTx = await provider.signTransaction(tx);
    const signature = await conn.sendRawTransaction(signedTx.serialize(), {
      skipPreflight: false,
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

    setStatus('🔥 Burned. Your slot will appear on the leaderboard within ~10 minutes once the indexer picks it up.<br>' +
      '<a href="https://solscan.io/tx/' + signature + '" target="_blank">View transaction ↗</a>', 'success');
    await refreshBalance();
  } catch (err) {
    const m = err?.message || String(err);
    const ml = m.toLowerCase();
    let msg;
    if (ml.includes('user rejected') || ml.includes('user canceled') || ml.includes('user cancelled')) {
      // User clicked Cancel in their wallet's confirm prompt.
      msg = 'Transaction cancelled in wallet — <strong>your tokens were not touched.</strong>';
    } else if (m.startsWith('BLOCKHASH_EXPIRED') || ml.includes('blockhash not found') || ml.includes('signature has expired') || ml.includes('block height exceeded')) {
      // The blockhash on the signed tx aged past its 150-slot validity
      // window before the leader could include it. Common cause: the
      // user took longer than ~60s to click Confirm in the wallet.
      msg = 'The transaction expired before it could land on chain. ' +
            'This happens when the wallet-confirm step takes longer than ~60 seconds. ' +
            '<strong>Your tokens are safe</strong> — no burn was executed. ' +
            'Refresh the page and try again — Phantom will prompt faster the second time.';
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
      // The signature was never sent or never landed; tokens are safe.
      msg = '<strong>Your tokens are safe.</strong> An error occurred before the burn could complete: ' + escapeHtml(m);
    }
    setStatus(msg, 'error');
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
