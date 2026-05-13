// ─── ATOMIC SWAP + BURN ─────────────────────────────────────────────
// One-signature flow that does (acquire PYRE) + (burn it) + (inscribe
// the memo) inside a single VersionedTransaction. The user pays in
// whatever token they have (SOL / USDC / USDT) and never needs to
// hold PYRE first — Jupiter routes the swap, our burn instruction
// destroys the output at the protocol layer, the memo lands the
// inscription on the leaderboard.
//
// Flow:
//   1. Jupiter ExactOut quote — "to receive exactly N PYRE, how much
//      <payMint> do I need to provide?"
//   2. Jupiter /swap-instructions — returns the raw TransactionInstruction[]
//      shape (computeBudget + setup + swap + cleanup + ALTs) instead
//      of a pre-built transaction.
//   3. We append our [BurnChecked + Memo + beacon-marker] instructions
//      AFTER the swap and BEFORE the cleanup so the burn sees the
//      freshly-swapped PYRE.
//   4. Resolve the Address Lookup Tables Jupiter references.
//   5. Compile to a v0 message, wrap in VersionedTransaction, return.
//
// Caller (burn.js) signs + broadcasts the tx exactly like the direct-
// burn flow — same wallet plumbing, same retry/confirm machinery.
//
// Constraints + invariants:
//   - swapMode='ExactOut' makes the OUTPUT amount fixed; the burn
//     instruction can safely reference the exact requested N PYRE.
//     Any input-side slippage is bounded by quote.otherAmountThreshold.
//   - wrapAndUnwrapSol:true means Jupiter handles WSOL wrap/unwrap
//     transparently when input is SOL.
//   - PYRE is a Token-2022 mint — TOKEN_2022_PROGRAM_ID everywhere
//     ATAs and burns are touched (per CLAUDE.md §7.3).
//   - The 1-lamport transfer to INSCRIPTION_BEACON is what marks this
//     tx as a pyrecoin.com inscription for the ingest cron's
//     getSignaturesForAddress(beacon) scan.

import {
  PublicKey, Transaction, TransactionInstruction, TransactionMessage,
  VersionedTransaction, AddressLookupTableAccount, SystemProgram, ComputeBudgetProgram
} from '../vendor/web3.mjs';
import {
  createBurnCheckedInstruction, getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID
} from '../vendor/spl-token.mjs';
import {
  PYRE_MINT_STR, MEMO_PROGRAM_ID_STR, INSCRIPTION_BEACON_STR,
  SOL_MINT_STR, USDC_MINT_STR, USDT_MINT_STR, JUP, SWAP_DEFAULTS,
} from './config.js';
import { scaleToRaw } from './utils.js';
import { getPyreDecimals } from './data.js';

// Token registry mirrors the buy form; kept here separately so the
// atomic-burn module is self-contained and importable without the
// buy UI being loaded.
export const PAY_TOKENS = {
  sol:  { mint: SOL_MINT_STR,  decimals: 9, symbol: 'SOL'  },
  usdc: { mint: USDC_MINT_STR, decimals: 6, symbol: 'USDC' },
  usdt: { mint: USDT_MINT_STR, decimals: 6, symbol: 'USDT' },
};

// ─── helpers ─────────────────────────────────────────────────────────

function base64ToBytes(b64) {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}

// Jupiter's instruction shape: { programId, accounts:[{pubkey,isSigner,isWritable}], data:base64 }.
// Convert to a TransactionInstruction. base64 → bytes via atob, NOT Buffer
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
    slippageBps: String(SWAP_DEFAULTS.SLIPPAGE_BPS),
    swapMode: 'ExactOut',
    restrictIntermediateTokens: 'true',
  });
  const res = await fetch(`${JUP.QUOTE}?${params}`, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`quote ${res.status}${body ? ' · ' + body.slice(0, 200) : ''}`);
  }
  return res.json();
}

async function fetchSwapInstructions(quoteResponse, userPublicKey) {
  const res = await fetch(JUP.SWAP_INSTRUCTIONS, {
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
          maxLamports: SWAP_DEFAULTS.MAX_PRIORITY_LAMPORTS,
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

// Fetch a pre-built Jupiter swap transaction (NOT the instructions
// shape — this returns a complete v0 tx ready to sign + send). Used
// by the 2-tx fallback when the atomic instruction-shape variant
// would exceed Solana's 1232-byte limit. Same defaults as the atomic
// path (dynamic slippage, very-high priority, 2M lamport cap).
async function fetchPrebuiltSwap(quoteResponse, userPublicKey) {
  const res = await fetch(JUP.SWAP, {
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
          maxLamports: SWAP_DEFAULTS.MAX_PRIORITY_LAMPORTS,
        },
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`swap ${res.status}${body ? ' · ' + body.slice(0, 200) : ''}`);
  }
  return res.json();
}

// ─── core builder ───────────────────────────────────────────────────

/**
 * Build the atomic swap+burn+inscribe VersionedTransaction.
 *
 * @param {object} args
 * @param {import('../vendor/web3.mjs').Connection} args.conn — RPC connection
 * @param {PublicKey}  args.payer       — user's wallet pubkey
 * @param {string}     args.payMint     — base58 of the pay-with mint (SOL/USDC/USDT)
 * @param {number}     args.totalBurnAmt — PYRE amount to burn (service fee + leaderboard)
 * @param {number}     [args.extraPyreAmt=0] — extra PYRE to acquire on top of the burn
 *                                              and leave in the user's ATA (optional add-on).
 * @param {string}     args.memoText    — non-empty memo to attach as the Memo Program payload
 *
 * @returns {Promise<{tx: VersionedTransaction, lastValidBlockHeight: number, maxInputAmount: bigint, sizeBytes: number}>}
 */
export async function buildAtomicBurnTx({ conn, payer, payMint, totalBurnAmt, extraPyreAmt = 0, memoText }) {
  if (!(payer instanceof PublicKey)) throw new Error('payer must be a PublicKey');
  if (!payMint || typeof payMint !== 'string') throw new Error('payMint required');
  if (!Number.isFinite(totalBurnAmt) || totalBurnAmt <= 0) {
    throw new Error('totalBurnAmt must be > 0');
  }
  if (!Number.isFinite(extraPyreAmt) || extraPyreAmt < 0) extraPyreAmt = 0;

  const pyreDecimals = await getPyreDecimals();
  const burnRawAmount = scaleToRaw(totalBurnAmt, pyreDecimals);
  // Total to ACQUIRE via the swap = the amount we'll burn + any extra
  // the user wants left in their wallet. The burn instruction below
  // only burns `burnRawAmount`; the extra naturally stays in the ATA.
  const totalAcquire = totalBurnAmt + extraPyreAmt;
  const acquireRawAmount = scaleToRaw(totalAcquire, pyreDecimals);

  // 1. Quote: ExactOut N PYRE for the FULL acquire amount.
  const quote = await fetchExactOutQuote(payMint, acquireRawAmount.toString());

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

// ─── 2-tx fallback builders ─────────────────────────────────────────
// When the atomic single-tx form exceeds Solana's 1232-byte limit
// (heavy Jupiter routes through illiquid pools, etc.), submitBurn
// falls back to a sequenced 2-tx flow: first acquire the PYRE, then
// burn + inscribe. Each tx fits comfortably under the limit because
// the swap is on its own and our burn-only tx is tiny.
//
// Partial-fill behaviour: if the user signs tx1 and cancels tx2,
// they keep the freshly-acquired PYRE in their wallet. No refund
// path — they can burn it later via the direct-PYRE path or just
// hold it. The caller is responsible for warning the user about the
// 2-step ceremony before kicking it off.

/**
 * Build a swap-only VersionedTransaction (no burn, no memo). Uses
 * Jupiter's /swap endpoint (which returns a pre-built tx) instead of
 * /swap-instructions, because we're not splicing anything in. The
 * follow-up burn tx (buildBurnOnlyTx) burns only `totalBurnAmt`; the
 * extra acquired stays in the user's ATA.
 *
 * @returns {Promise<{tx: VersionedTransaction, lastValidBlockHeight: number, quote: object}>}
 */
export async function buildSwapOnlyTx({ payer, payMint, totalBurnAmt, extraPyreAmt = 0 }) {
  if (!(payer instanceof PublicKey)) throw new Error('payer must be a PublicKey');
  if (!Number.isFinite(totalBurnAmt) || totalBurnAmt <= 0) {
    throw new Error('totalBurnAmt must be > 0');
  }
  if (!Number.isFinite(extraPyreAmt) || extraPyreAmt < 0) extraPyreAmt = 0;
  const pyreDecimals = await getPyreDecimals();
  const acquireRawAmount = scaleToRaw(totalBurnAmt + extraPyreAmt, pyreDecimals);

  // ExactOut quote so the user receives exactly the target PYRE
  // amount (within slippage on the INPUT side). The follow-up burn
  // tx burns only the burn portion; the extra stays in their ATA.
  const quote = await fetchExactOutQuote(payMint, acquireRawAmount.toString());
  const data = await fetchPrebuiltSwap(quote, payer.toBase58());

  const txBytes = Uint8Array.from(atob(data.swapTransaction), c => c.charCodeAt(0));
  const tx = VersionedTransaction.deserialize(txBytes);

  return { tx, lastValidBlockHeight: data.lastValidBlockHeight, quote };
}

/**
 * Build a burn-only legacy Transaction: BurnChecked + Memo + 1-lamport
 * beacon. Burns the exact `totalBurnAmt` PYRE the swap delivered.
 * Stays a legacy Transaction (not v0) because it's small and the wallet
 * adapter handles both types — no need for ALTs at this size.
 *
 * @returns {Promise<{tx: Transaction, lastValidBlockHeight: number}>}
 */
export async function buildBurnOnlyTx({ conn, payer, totalBurnAmt, memoText }) {
  if (!(payer instanceof PublicKey)) throw new Error('payer must be a PublicKey');
  if (!Number.isFinite(totalBurnAmt) || totalBurnAmt <= 0) {
    throw new Error('totalBurnAmt must be > 0');
  }
  if (!memoText || typeof memoText !== 'string') {
    throw new Error('memoText required');
  }
  const pyreDecimals = await getPyreDecimals();
  const burnRawAmount = scaleToRaw(totalBurnAmt, pyreDecimals);
  const mint = new PublicKey(PYRE_MINT_STR);
  const senderAta = getAssociatedTokenAddressSync(mint, payer, false, TOKEN_2022_PROGRAM_ID);

  const tx = new Transaction();
  // Small priority fee — helps the burn land fast after the swap
  // confirms. Static value (matches the direct-burn path constants).
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }));
  tx.add(createBurnCheckedInstruction(
    senderAta, mint, payer, burnRawAmount, pyreDecimals, [], TOKEN_2022_PROGRAM_ID
  ));
  tx.add(new TransactionInstruction({
    keys: [{ pubkey: payer, isSigner: true, isWritable: false }],
    programId: new PublicKey(MEMO_PROGRAM_ID_STR),
    data: new TextEncoder().encode(memoText),
  }));
  tx.add(SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: new PublicKey(INSCRIPTION_BEACON_STR),
    lamports: 1,
  }));

  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('processed');
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer;
  return { tx, lastValidBlockHeight };
}
