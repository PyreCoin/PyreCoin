// ─── ATOMIC SWAP + BURN ─────────────────────────────────────────────
// One-signature flow that does (acquire $PYRE) + (burn it) + (inscribe
// the memo) inside a single VersionedTransaction. The user pays in
// whatever token they have (SOL / USDC / USDT) and never needs to
// hold $PYRE first — Jupiter routes the swap, our burn instruction
// destroys the output at the protocol layer, the memo lands the
// inscription on the leaderboard.
//
// Flow:
//   1. Jupiter ExactOut quote — "to receive exactly N $PYRE, how much
//      <payMint> do I need to provide?"
//   2. Jupiter /swap-instructions — returns the raw TransactionInstruction[]
//      shape (computeBudget + setup + swap + cleanup + ALTs) instead
//      of a pre-built transaction.
//   3. We append our [BurnChecked + Memo + beacon-marker] instructions
//      AFTER the swap and BEFORE the cleanup so the burn sees the
//      freshly-swapped $PYRE.
//   4. Resolve the Address Lookup Tables Jupiter references.
//   5. Compile to a v0 message, wrap in VersionedTransaction, return.
//
// Caller (burn.js) signs + broadcasts the tx exactly like the direct-
// burn flow — same wallet plumbing, same retry/confirm machinery.
//
// Constraints + invariants:
//   - swapMode='ExactOut' makes the OUTPUT amount fixed; the burn
//     instruction can safely reference the exact requested N $PYRE.
//     Any input-side slippage is bounded by quote.otherAmountThreshold.
//   - wrapAndUnwrapSol:true means Jupiter handles WSOL wrap/unwrap
//     transparently when input is SOL.
//   - PYRE is a Token-2022 mint — TOKEN_2022_PROGRAM_ID everywhere
//     ATAs and burns are touched (per CLAUDE.md §7.3).
//   - The 1-lamport transfer to INSCRIPTION_BEACON is what marks this
//     tx as a pyrecoin.com inscription for the ingest cron's
//     getSignaturesForAddress(beacon) scan.

import {
  Connection, PublicKey, TransactionInstruction, TransactionMessage,
  VersionedTransaction, AddressLookupTableAccount, SystemProgram
} from 'https://esm.sh/@solana/web3.js@1.98.4';
import {
  createBurnCheckedInstruction, getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID
} from 'https://esm.sh/@solana/spl-token@0.4.14';
import { PYRE_MINT_STR, MEMO_PROGRAM_ID_STR, INSCRIPTION_BEACON_STR } from './config.js';

const JUP_QUOTE = 'https://lite-api.jup.ag/swap/v1/quote';
const JUP_SWAP_INSTRUCTIONS = 'https://lite-api.jup.ag/swap/v1/swap-instructions';

// 3% static slippage floor + dynamicSlippage:true. Same as the buy
// form. Memecoin pools have less depth — 1% fails constantly.
const SLIPPAGE_BPS = 300;
const MAX_PRIORITY_LAMPORTS = 2_000_000;

// Token registry mirrors the buy form; kept here separately so the
// atomic-burn module is self-contained and importable without the
// buy UI being loaded.
const SOL_MINT  = 'So11111111111111111111111111111111111111112';
export const PAY_TOKENS = {
  sol:  { mint: SOL_MINT,                                       decimals: 9, symbol: 'SOL'  },
  usdc: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC' },
  usdt: { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, symbol: 'USDT' },
};

// ─── helpers ─────────────────────────────────────────────────────────

function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// Jupiter's instruction shape: { programId, accounts:[{pubkey,isSigner,isWritable}], data:base64 }.
// Convert to a TransactionInstruction. base64 → bytes via atom, NOT Buffer
// (Buffer isn't available in the browser without a polyfill).
function deserializeJupInstruction(instr) {
  return new TransactionInstruction({
    programId: new PublicKey(instr.programId),
    keys: instr.accounts.map(k => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: base64ToBytes(instr.data),
  });
}

// Fetch and deserialize every ALT Jupiter's swap references. A v0
// message can reference accounts via lookup tables instead of inline,
// shrinking the tx payload. Without resolving the ALT accounts here
// the compiled message wouldn't know how to expand the indices.
async function getAddressLookupTableAccounts(conn, addresses) {
  if (!addresses || addresses.length === 0) return [];
  const keys = addresses.map(a => new PublicKey(a));
  const infos = await conn.getMultipleAccountsInfo(keys);
  const out = [];
  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    if (info) {
      out.push(new AddressLookupTableAccount({
        key: keys[i],
        state: AddressLookupTableAccount.deserialize(info.data),
      }));
    }
  }
  return out;
}

// ─── Jupiter calls ──────────────────────────────────────────────────

// ExactOut quote — "to receive `outAmount` of PYRE, how much
// `payMint` do I need to spend?" Returns the full quoteResponse
// object verbatim (must be passed back to /swap-instructions
// byte-for-byte; Jupiter signs/validates the route shape).
export async function fetchExactOutQuote(payMint, outAmountRaw) {
  const params = new URLSearchParams({
    inputMint: payMint,
    outputMint: PYRE_MINT_STR,
    amount: outAmountRaw,
    slippageBps: String(SLIPPAGE_BPS),
    swapMode: 'ExactOut',
    restrictIntermediateTokens: 'true',
  });
  const res = await fetch(`${JUP_QUOTE}?${params}`, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`quote ${res.status}${body ? ' · ' + body.slice(0, 200) : ''}`);
  }
  return res.json();
}

async function fetchSwapInstructions(quoteResponse, userPublicKey) {
  const res = await fetch(JUP_SWAP_INSTRUCTIONS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey,
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          priorityLevel: 'veryHigh',
          maxLamports: MAX_PRIORITY_LAMPORTS,
        },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`swap-instructions ${res.status}${body ? ' · ' + body.slice(0, 200) : ''}`);
  }
  return res.json();
}

// ─── PYRE mint decimals (cached) ────────────────────────────────────

let _pyreDecimalsCache = null;
async function getPyreDecimals(conn) {
  if (_pyreDecimalsCache != null) return _pyreDecimalsCache;
  const info = await conn.getParsedAccountInfo(new PublicKey(PYRE_MINT_STR));
  const d = info?.value?.data?.parsed?.info?.decimals;
  if (typeof d !== 'number') throw new Error('Could not read $PYRE decimals');
  _pyreDecimalsCache = d;
  return d;
}

// ─── core builder ───────────────────────────────────────────────────

/**
 * Build the atomic swap+burn+inscribe VersionedTransaction.
 *
 * @param {object} args
 * @param {Connection} args.conn        — RPC connection
 * @param {PublicKey}  args.payer       — user's wallet pubkey
 * @param {string}     args.payMint     — base58 of the pay-with mint (SOL/USDC/USDT)
 * @param {number}     args.totalBurnAmt — total $PYRE to acquire-and-burn (service fee + leaderboard)
 * @param {string}     args.memoText    — non-empty memo to attach as the Memo Program payload
 *
 * @returns {Promise<{tx: VersionedTransaction, lastValidBlockHeight: number, maxInputAmount: bigint, sizeBytes: number}>}
 */
export async function buildAtomicBurnTx({ conn, payer, payMint, totalBurnAmt, memoText }) {
  if (!(payer instanceof PublicKey)) throw new Error('payer must be a PublicKey');
  if (!payMint || typeof payMint !== 'string') throw new Error('payMint required');
  if (!Number.isFinite(totalBurnAmt) || totalBurnAmt <= 0) {
    throw new Error('totalBurnAmt must be > 0');
  }

  const pyreDecimals = await getPyreDecimals(conn);
  // Scale the burn amount to raw units via integer math (toFixed +
  // string concat) to avoid 0.1+0.2 floating-point drift.
  const s = totalBurnAmt.toFixed(pyreDecimals);
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(pyreDecimals)).slice(0, pyreDecimals);
  const burnRawAmount = BigInt(whole) * 10n ** BigInt(pyreDecimals) + BigInt(padded || '0');

  // 1. Quote: ExactOut N PYRE.
  const quote = await fetchExactOutQuote(payMint, burnRawAmount.toString());

  // 2. Instructions for the swap. Body shape per Jupiter Swap V1 ref.
  const swapData = await fetchSwapInstructions(quote, payer.toBase58());

  // 3. Resolve ALTs Jupiter references.
  const altAccounts = await getAddressLookupTableAccounts(
    conn, swapData.addressLookupTableAddresses || []
  );

  // 4. Build our trailing instructions (burn + memo + 1-lamport beacon).
  const mint = new PublicKey(PYRE_MINT_STR);
  const senderAta = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_2022_PROGRAM_ID);

  const burnIx = createBurnCheckedInstruction(
    senderAta, mint, payer, burnRawAmount, pyreDecimals, [], TOKEN_2022_PROGRAM_ID
  );
  const memoIx = new TransactionInstruction({
    keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
    programId: new PublicKey(MEMO_PROGRAM_ID_STR),
    data: new TextEncoder().encode(memoText),
  });
  // 1-lamport transfer to the inscription beacon — pyrecoin.com
  // ingest scans getSignaturesForAddress(beacon) to find these.
  // Anyone can replicate the shape from any wallet; the beacon is
  // a deterministic marker, not a permission gate.
  const beaconIx = SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: new PublicKey(INSCRIPTION_BEACON_STR),
    lamports: 1,
  });

  // 5. Compose final instruction order:
  //    compute budget → setup (ATA creation, WSOL wrap) → swap → burn
  //    → memo → beacon → cleanup (WSOL unwrap, etc.)
  //    The burn MUST come AFTER the swap so the PYRE is in the ATA.
  //    Cleanup runs LAST so the WSOL account unwraps with whatever's
  //    left in it after our burn fee path.
  const instructions = [
    ...(swapData.computeBudgetInstructions || []).map(deserializeJupInstruction),
    ...(swapData.setupInstructions || []).map(deserializeJupInstruction),
    deserializeJupInstruction(swapData.swapInstruction),
    burnIx,
    memoIx,
    beaconIx,
    ...(swapData.cleanupInstruction ? [deserializeJupInstruction(swapData.cleanupInstruction)] : []),
  ];

  // 6. Build the v0 message.
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('processed');
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(altAccounts);

  const tx = new VersionedTransaction(message);

  // Measure serialized size before sending — Solana hard-caps at 1232
  // bytes. Return the size so the caller can decide whether to send
  // or fall back to a 2-tx flow.
  let sizeBytes = -1;
  try {
    sizeBytes = tx.serialize().length;
  } catch {
    // serialize throws if the message is malformed; treat as oversize.
    sizeBytes = 9999;
  }

  // For UX/billing: surface the maximum input the user might pay.
  // ExactOut quotes have `otherAmountThreshold` = max input with slippage.
  const maxInputAmount = BigInt(quote.otherAmountThreshold || quote.inAmount);

  return { tx, lastValidBlockHeight, maxInputAmount, sizeBytes, quote };
}
