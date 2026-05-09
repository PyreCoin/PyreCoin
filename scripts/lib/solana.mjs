// Solana RPC poller — native-burn detection.
//
// We watch the *mint account itself* for new transactions. The Token-2022
// `Burn` and `BurnChecked` instructions reference the mint as account
// index 1, so getSignaturesForAddress(mint) returns every transaction
// that burns our token. (It also returns every transferChecked, since
// transfers reference the mint too — those get filtered out below.)
//
// To avoid pulling the full body of every mint-touching tx — Jupiter
// swaps, Raydium routes, ATA creations — we pre-filter the signature
// list using the cheap `memo` field returned by getSignaturesForAddress.
// Burns through pyrecoin.com always include a memo (`url=… | msg=…`).
// Signatures with `memo === null` cannot match our shape and are
// skipped without spending an RPC credit on the full transaction.
//
// For each candidate signature we pull the full parsed transaction and
// look for spl-token / spl-token-2022 instructions of type `burn` or
// `burnChecked` whose `info.mint` matches our mint. Inner instructions
// are scanned too (CPI burns count). The burn is attributed to
// `info.authority` — the owner or delegate that authorized the burn.
//
// History (2026-05-09): the original poller watched a *transfer-to-null*
// associated token account for the burn-owner address `11111…1111`.
// That worked but it left the on-chain mint supply unchanged forever,
// which made the deflationary claim unverifiable from any external
// indexer. Switching to native Burn means the chain itself is the
// source of truth for "tokens removed."

import {
  Connection,
  PublicKey,
} from '@solana/web3.js';

// Pump.fun mints SPL tokens under the Token-2022 program (NOT the
// legacy Token program). Token-2022 instructions still parse with
// type strings 'burn' and 'burnChecked' — only the program ID
// changes. Filtering by program ID below catches both the
// `program: 'spl-token-2022'` parsing and the raw program-key match.
const TOKEN_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MEMO_PROGRAM_IDS = new Set([
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
]);

export function makeConnection(rpcUrl) {
  return new Connection(rpcUrl, 'confirmed');
}

export async function fetchMintDecimals(connection, mint) {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  if (!info?.value?.data?.parsed?.info?.decimals) {
    throw new Error(`mint ${mint} not found or unparseable`);
  }
  return info.value.data.parsed.info.decimals;
}

// Walk signatures for `address`, newest-first, until we hit
// `untilSignature` (exclusive) or process `maxSignatures` entries.
// Returns the memo-bearing signatures (the only ones worth fetching
// the full body of) and the newest signature seen — even if that
// newest didn't have a memo, it's still our checkpoint, otherwise
// the next cron run would reprocess all the memoless traffic we
// just walked.
async function fetchNewSignatures(connection, address, untilSignature, maxSignatures = 500) {
  const memoed = [];
  let newest = null;
  let walked = 0;
  let before;
  while (walked < maxSignatures) {
    const batch = await connection.getSignaturesForAddress(address, {
      limit: Math.min(1000, maxSignatures - walked),
      before,
      until: untilSignature || undefined,
    });
    if (!batch.length) break;
    if (newest === null) newest = batch[0].signature;
    for (const s of batch) {
      walked++;
      if (untilSignature && s.signature === untilSignature) {
        return { sigs: memoed, newest };
      }
      if (s.memo !== null && s.memo !== undefined) memoed.push(s);
    }
    before = batch[batch.length - 1].signature;
    if (batch.length < 1000) break;
  }
  return { sigs: memoed, newest };
}

// Pull transaction bodies in parallel with a small concurrency cap so we don't
// hammer the RPC. A free-tier RPC will rate-limit us hard otherwise.
async function fetchTransactions(connection, signatures, concurrency = 4) {
  const out = new Array(signatures.length);
  let cursor = 0;
  async function worker() {
    while (cursor < signatures.length) {
      const i = cursor++;
      try {
        out[i] = await connection.getParsedTransaction(signatures[i].signature, {
          maxSupportedTransactionVersion: 0,
        });
      } catch (e) {
        out[i] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

// Extract the burn-with-memo shape from a parsed transaction. Returns
// null if the transaction doesn't contain a `burn` or `burnChecked`
// instruction for `mint` PLUS at least one Memo Program payload.
//
// Sums burn amounts across top-level + inner instructions in case a
// single tx contains multiple burns (rare, but well-formed). Signer
// is taken from the burn instruction's `authority` field (the owner
// or delegate that signed the burn) — this can differ from the tx
// fee-payer if a delegate burned on the owner's behalf, and we want
// to attribute the leaderboard slot to the actual burner.
export function extractBurn(tx, mint) {
  if (!tx || !tx.meta || tx.meta.err) return null;

  let amount = 0;
  let memo = null;
  let signer = null;

  const allInstructions = [
    ...(tx.transaction.message.instructions || []),
    ...(tx.meta.innerInstructions?.flatMap(ii => ii.instructions) || []),
  ];

  for (const ix of allInstructions) {
    const pid = ix.programId?.toString?.() ?? ix.programId;

    // Memo extraction (any of the Memo Program IDs).
    if (MEMO_PROGRAM_IDS.has(pid)) {
      if (typeof ix.parsed === 'string') memo = ix.parsed;
      else if (ix.parsed?.info) memo = ix.parsed.info;
      else if (ix.data) {
        // base64/utf8 fallback for unparsed memo instructions.
        try { memo = Buffer.from(ix.data, 'base64').toString('utf8'); }
        catch { /* ignore */ }
      }
    }

    // Burn extraction: only the Token-2022 program, only burn types,
    // only our mint.
    if (pid === TOKEN_PROGRAM_ID.toString() && ix.parsed) {
      const t = ix.parsed.type;
      const info = ix.parsed.info || {};
      if ((t === 'burn' || t === 'burnChecked') && info.mint === mint) {
        // burnChecked always returns a tokenAmount object with uiAmount.
        // Plain burn (uncommon — our website uses burnChecked) may not,
        // in which case we skip rather than misreport raw lamport-units
        // as UI amount. Misattributing 1,000,000 raw → 1,000,000 PYRE
        // at 6 decimals would inflate the leaderboard by 6 orders of
        // magnitude.
        const ui = info.tokenAmount?.uiAmount;
        if (typeof ui === 'number' && Number.isFinite(ui) && ui > 0) {
          amount += ui;
          if (!signer) signer = info.authority || null;
        }
      }
    }
  }

  if (amount <= 0 || !memo) return null;
  return {
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    blockTime: tx.blockTime, // unix seconds, may be null
    signer,
    amount,
    memo,
  };
}

// Public API: fetch all new burns since `untilSignature`. Returns burns
// ordered oldest-first and the newest signature seen (for checkpointing).
export async function fetchNewBurns({ connection, mint, untilSignature, maxSignatures = 500 }) {
  const mintKey = new PublicKey(mint);
  const { sigs, newest } = await fetchNewSignatures(connection, mintKey, untilSignature, maxSignatures);
  if (!sigs.length) {
    return { burns: [], newestSignature: newest || untilSignature };
  }

  const txs = await fetchTransactions(connection, sigs);
  const burns = [];
  for (let i = 0; i < txs.length; i++) {
    const b = extractBurn(txs[i], mint);
    if (b) burns.push(b);
  }

  // sigs were newest-first; flip to oldest-first for ingestion
  burns.reverse();
  return { burns, newestSignature: newest };
}
