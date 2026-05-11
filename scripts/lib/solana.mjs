// Solana RPC poller — burns + inscriptions.
//
// Two ingest paths, same RPC patterns:
//
//   BURNS — getSignaturesForAddress(mint) returns every transaction
//   touching the mint. We fetch the parsed body, look for spl-token-2022
//   `burn` or `burnChecked` instructions of our mint, and emit one
//   record per tx (sums burns within a tx if there are multiple). A memo
//   is *optional* now: pyrecoin.com burns may carry a `url=… | x=… |
//   msg=…` memo, dust-sweeper / external burns carry none. Memo-less
//   burns surface as "pure" entries on the leaderboard.
//
//   INSCRIPTIONS — getSignaturesForAddress(BEACON) returns every tx that
//   sent SOL to the inscription beacon address. pyrecoin.com inscriptions
//   include exactly a 1-lamport transfer to the beacon + a Memo Program
//   instruction. We pull the parsed body and emit one record per memo.
//   Anyone can inscribe by replicating this shape — the beacon is just
//   a deterministic marker (PDA derived from "pyrecoin:inscriptions:v1"
//   against the PYRE mint, off-curve, no private key exists).
//
// History (2026-05-09): the prior poller had a `s.memo !== null`
// prefilter on the signature list to skip Jupiter swap traffic without
// paying for tx body fetches. That cost-control filter silently hid
// memo-less burns of our mint (incl. one ~695-PYRE dust-sweep that
// dropped circulating supply in a way the leaderboard couldn't
// explain). Filter removed; at current volume, fetching every tx body
// is cheap. If volume grows enough to matter, re-add a smarter pass
// that still surfaces memo-less burns.

import {
  Connection,
  PublicKey,
} from '@solana/web3.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const MEMO_PROGRAM_IDS = new Set([
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
]);

// Inscription beacon — see js/config.js for the rationale on the same
// address. PDA derived from ["pyrecoin:inscriptions:v1"] against the
// PYRE mint; off-curve, deterministic, no private key.
export const INSCRIPTION_BEACON = '2yqR9bjy64UqnWYP4wTrpw8RwFqXGQnkhzQRSp11MmDi';

export function makeConnection(rpcUrl) {
  return new Connection(rpcUrl, 'confirmed');
}

export async function fetchMintDecimals(connection, mint) {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const dec = info?.value?.data?.parsed?.info?.decimals;
  if (typeof dec !== 'number') {
    throw new Error(`mint ${mint} not found or unparseable`);
  }
  return dec;
}

// Walk signatures for `address`, newest-first, until we hit
// `untilSignature` (exclusive) or process `maxSignatures` entries.
// Returns every signature in the range — no memo prefilter — and the
// newest signature seen, even if it didn't match anything, so the
// next run's checkpoint advances.
async function fetchNewSignatures(connection, address, untilSignature, maxSignatures = 500) {
  const out = [];
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
        return { sigs: out, newest };
      }
      out.push(s);
    }
    before = batch[batch.length - 1].signature;
    if (batch.length < 1000) break;
  }
  return { sigs: out, newest };
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

// Extract the burn-with-optional-memo shape from a parsed transaction.
// Returns null if the tx is errored or contains no `burn` / `burnChecked`
// for our `mint`. Otherwise returns { signature, slot, blockTime, signer,
// amount, memo } where memo is the spl-memo payload (string) or null.
//
// Accepts both `burnChecked` (carries tokenAmount with uiAmount) and
// plain `burn` (raw amount only — we divide by 10^decimals using the
// caller-supplied mint decimals to recover UI units). The previous
// version refused plain burns because decimals weren't available
// here; now they are.
//
// Sums burn amounts across top-level + inner instructions in case a
// single tx contains multiple burns (the bulk dust-sweeper case is the
// motivating example).
export function extractBurn(tx, mint, decimals) {
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

    if (MEMO_PROGRAM_IDS.has(pid)) {
      if (typeof ix.parsed === 'string') memo = ix.parsed;
      else if (ix.parsed?.info) memo = ix.parsed.info;
      else if (ix.data) {
        try { memo = Buffer.from(ix.data, 'base64').toString('utf8'); }
        catch { /* ignore */ }
      }
    }

    if (pid === TOKEN_PROGRAM_ID.toString() && ix.parsed) {
      const t = ix.parsed.type;
      const info = ix.parsed.info || {};
      if ((t === 'burn' || t === 'burnChecked') && info.mint === mint) {
        let ui = info.tokenAmount?.uiAmount;
        if (typeof ui !== 'number' || !Number.isFinite(ui)) {
          // Plain `burn` — no tokenAmount. Convert raw amount → UI units
          // using the caller-supplied mint decimals.
          const rawStr = info.amount;
          if (typeof decimals === 'number' && rawStr) {
            const raw = Number(rawStr);
            if (Number.isFinite(raw) && raw > 0) ui = raw / 10 ** decimals;
          }
        }
        if (typeof ui === 'number' && Number.isFinite(ui) && ui > 0) {
          amount += ui;
          if (!signer) signer = info.authority || null;
        }
      }
    }
  }

  if (amount <= 0) return null;
  return {
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    blockTime: tx.blockTime,
    signer,
    amount,
    memo,
  };
}

// Extract an inscription from a beacon-targeting transaction. Returns
// { signature, slot, blockTime, signer, memo } if the tx contains at
// least one Memo Program instruction; null otherwise. Note: ALL
// signatures returned by getSignaturesForAddress(beacon) target the
// beacon, so we don't re-verify the transfer here — but we do require
// a memo, since an inscription without content has no reason to exist
// on the wall.
export function extractInscription(tx) {
  if (!tx || !tx.meta || tx.meta.err) return null;

  let memo = null;
  let signer = null;

  const allInstructions = [
    ...(tx.transaction.message.instructions || []),
    ...(tx.meta.innerInstructions?.flatMap(ii => ii.instructions) || []),
  ];

  for (const ix of allInstructions) {
    const pid = ix.programId?.toString?.() ?? ix.programId;
    if (MEMO_PROGRAM_IDS.has(pid)) {
      if (typeof ix.parsed === 'string') memo = ix.parsed;
      else if (ix.parsed?.info) memo = ix.parsed.info;
      else if (ix.data) {
        try { memo = Buffer.from(ix.data, 'base64').toString('utf8'); }
        catch { /* ignore */ }
      }
    }
  }

  if (!memo) return null;
  // Fee payer is the inscriber.
  signer = tx.transaction.message.accountKeys?.[0];
  if (signer && typeof signer === 'object') signer = signer.pubkey?.toString?.() ?? signer.toString?.() ?? signer;

  return {
    signature: tx.transaction.signatures[0],
    slot: tx.slot,
    blockTime: tx.blockTime,
    signer,
    memo,
  };
}

// Public API: fetch all new burns since `untilSignature`. Returns burns
// ordered oldest-first and the newest signature seen (for checkpointing).
export async function fetchNewBurns({ connection, mint, untilSignature, maxSignatures = 500, decimals }) {
  const mintKey = new PublicKey(mint);
  const { sigs, newest } = await fetchNewSignatures(connection, mintKey, untilSignature, maxSignatures);
  if (!sigs.length) {
    return { burns: [], newestSignature: newest || untilSignature };
  }

  // If decimals weren't provided by the caller, look them up once.
  let dec = decimals;
  if (typeof dec !== 'number') {
    dec = await fetchMintDecimals(connection, mint);
  }

  const txs = await fetchTransactions(connection, sigs);
  const burns = [];
  for (let i = 0; i < txs.length; i++) {
    const b = extractBurn(txs[i], mint, dec);
    if (b) burns.push(b);
  }

  burns.reverse(); // newest-first → oldest-first for chronological ingest
  return { burns, newestSignature: newest };
}

// Public API: fetch all new inscriptions since `untilSignature`. Same
// pattern as burns but addressed at the beacon. Memo Program payload
// is the inscription content.
export async function fetchNewInscriptions({ connection, beacon = INSCRIPTION_BEACON, untilSignature, maxSignatures = 500 }) {
  const addr = new PublicKey(beacon);
  const { sigs, newest } = await fetchNewSignatures(connection, addr, untilSignature, maxSignatures);
  if (!sigs.length) {
    return { inscriptions: [], newestSignature: newest || untilSignature };
  }

  const txs = await fetchTransactions(connection, sigs);
  const inscriptions = [];
  for (let i = 0; i < txs.length; i++) {
    const ins = extractInscription(txs[i]);
    if (ins) inscriptions.push(ins);
  }

  inscriptions.reverse(); // newest-first → oldest-first
  return { inscriptions, newestSignature: newest };
}
