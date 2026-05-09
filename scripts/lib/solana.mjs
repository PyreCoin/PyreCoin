// Solana RPC poller.
//
// We watch the *associated token account* of the system-program null address
// for the configured PYRE mint. SPL transfers TO that account are the burns
// users perform from the website's instructions ("send $PYRE to 1111...1111").
//
// For each new transaction touching that account, we extract:
//   - the SPL Token transfer amount (raw → uiAmount via mint decimals)
//   - the Memo Program payload (the "url=… | msg=…" string)
//   - the signer (the burner's wallet)
//   - blockTime + slot for the heat-decay timestamp
//
// Pagination works backward: getSignaturesForAddress returns newest first,
// and we stop walking once we hit our last-seen checkpoint signature.

import {
  Connection,
  PublicKey,
} from '@solana/web3.js';

// Well-known program IDs. Pump.fun mints SPL tokens under the
// Token-2022 program (NOT the legacy Token program). Using the legacy
// ID here would derive the wrong ATA for the burn-owner address AND
// would filter out the actual Token-2022 transfer instructions in
// extractBurn — silently dropping every burn. The Associated Token
// Program ID is the same for both Token and Token-2022 derivations.
const TOKEN_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
);
const MEMO_PROGRAM_IDS = new Set([
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
]);
const BURN_OWNER = new PublicKey('11111111111111111111111111111111');

export function getBurnTokenAccount(mint) {
  const mintKey = new PublicKey(mint);
  // ATA = PDA derived from (owner, TOKEN_PROGRAM_ID, mint) under the
  // Associated Token Program.
  const [ata] = PublicKey.findProgramAddressSync(
    [BURN_OWNER.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintKey.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

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

// Walk signatures until we hit `untilSignature` (exclusive) or `maxSignatures`.
async function fetchNewSignatures(connection, address, untilSignature, maxSignatures = 500) {
  const result = [];
  let before;
  while (result.length < maxSignatures) {
    const batch = await connection.getSignaturesForAddress(address, {
      limit: Math.min(1000, maxSignatures - result.length),
      before,
      until: untilSignature || undefined,
    });
    if (!batch.length) break;
    for (const s of batch) {
      if (untilSignature && s.signature === untilSignature) return result;
      result.push(s);
    }
    before = batch[batch.length - 1].signature;
    if (batch.length < 1000) break;
  }
  return result;
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

// Extract amount + memo from a parsed transaction. Returns null if the
// transaction doesn't match the expected burn shape.
function extractBurn(tx, burnTokenAccount) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const accountKeys = tx.transaction.message.accountKeys.map(k =>
    typeof k === 'string' ? k : k.pubkey.toString()
  );

  let amount = 0;
  let memo = null;
  let signer = null;

  // First account in the message that is `signer: true` is the burner.
  for (const k of tx.transaction.message.accountKeys) {
    if (typeof k === 'object' && k.signer) {
      signer = k.pubkey.toString();
      break;
    }
  }

  // Top-level + inner instructions, parsed.
  const allInstructions = [
    ...(tx.transaction.message.instructions || []),
    ...(tx.meta.innerInstructions?.flatMap(ii => ii.instructions) || []),
  ];

  for (const ix of allInstructions) {
    const pid = ix.programId?.toString?.() ?? ix.programId;
    if (MEMO_PROGRAM_IDS.has(pid)) {
      // Parsed memo can be a string or in the parsed `info` field
      if (typeof ix.parsed === 'string') memo = ix.parsed;
      else if (ix.parsed?.info) memo = ix.parsed.info;
      else if (ix.data) {
        // base64/utf8 fallback
        try { memo = Buffer.from(ix.data, 'base64').toString('utf8'); }
        catch { /* ignore */ }
      }
    }
    if (pid === TOKEN_PROGRAM_ID.toString() && ix.parsed) {
      const t = ix.parsed.type;
      const info = ix.parsed.info || {};
      if ((t === 'transfer' || t === 'transferChecked') &&
          info.destination === burnTokenAccount.toString()) {
        const ui = info.tokenAmount?.uiAmount ?? Number(info.amount);
        if (Number.isFinite(ui)) amount += ui;
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
  const burnTokenAccount = getBurnTokenAccount(mint);
  const sigs = await fetchNewSignatures(connection, burnTokenAccount, untilSignature, maxSignatures);
  if (!sigs.length) return { burns: [], newestSignature: untilSignature };

  const txs = await fetchTransactions(connection, sigs);
  const burns = [];
  for (let i = 0; i < txs.length; i++) {
    const b = extractBurn(txs[i], burnTokenAccount);
    if (b) burns.push(b);
  }

  // sigs were newest-first; flip to oldest-first for ingestion
  burns.reverse();
  return { burns, newestSignature: sigs[0].signature };
}
