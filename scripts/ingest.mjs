#!/usr/bin/env node
// PYRE leaderboard ingest pipeline — main entry.
//
// Pulls new $PYRE burns from Solana, runs the deterministic moderation
// filter, and updates leaderboard.json (accepted) or pending.json
// (quarantined). Every decision lands in moderation-log.jsonl.
//
// Configuration (env):
//   PYRE_MINT         — SPL token mint address (required, except DRY_RUN)
//   SOLANA_RPC_URL    — RPC endpoint (required, except DRY_RUN)
//   MAX_SIGNATURES    — cap signatures fetched per run (default 500)
//   DRY_RUN=1         — skip RPC; log what would happen with mock data
//
// Designed to be invoked by .github/workflows/ingest.yml on a 5-min cron.
// Idempotent: re-running is safe — checkpointed via state.json, and
// applyAcceptedBurn de-dupes by tx hash.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Storage, applyAcceptedBurn, applyQuarantinedBurn } from './lib/storage.mjs';
import { parseMemo } from './lib/parse.mjs';
import { filterMemo } from './lib/filter.mjs';
import { fetchNewBurns, makeConnection } from './lib/solana.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.env.DRY_RUN === '1';

function log(msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));
}

async function fetchBurnsRPC() {
  const mint = process.env.PYRE_MINT;
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!mint || !rpcUrl) {
    throw new Error('PYRE_MINT and SOLANA_RPC_URL are required (or set DRY_RUN=1)');
  }
  const storage = new Storage(ROOT);
  const state = await storage.loadState();
  const connection = makeConnection(rpcUrl);
  const max = Number(process.env.MAX_SIGNATURES || 500);

  log('fetching burns', { mint, since: state.lastSignature, max });
  const { burns, newestSignature } = await fetchNewBurns({
    connection, mint,
    untilSignature: state.lastSignature,
    maxSignatures: max,
  });
  return { burns, newestSignature, storage };
}

// In DRY_RUN, fabricate one of each: a clean burn, a profane burn, a
// shortener burn. Useful for testing the filter + storage path end-to-end
// without RPC access.
function mockBurns() {
  const now = Math.floor(Date.now() / 1000);
  return {
    burns: [
      {
        signature: 'mock-clean-' + now,
        slot: 0,
        blockTime: now,
        signer: 'MockWalletA1...........................',
        amount: 12345,
        memo: 'url=cleanproject.xyz | msg=hello pyre',
      },
      {
        signature: 'mock-profanity-' + now,
        slot: 0,
        blockTime: now,
        signer: 'MockWalletB2...........................',
        amount: 6789,
        memo: 'url=example.com | msg=f*ck this',
      },
      {
        signature: 'mock-shortener-' + now,
        slot: 0,
        blockTime: now,
        signer: 'MockWalletC3...........................',
        amount: 4242,
        memo: 'url=https://bit.ly/aaaa | msg=spammy',
      },
    ],
    newestSignature: 'mock-newest-' + now,
    storage: new Storage(ROOT),
  };
}

async function main() {
  const { burns, newestSignature, storage } = DRY_RUN
    ? mockBurns()
    : await fetchBurnsRPC();

  log('burns to process', { count: burns.length });
  if (!burns.length) return;

  const lb = await storage.loadLeaderboard();
  const pending = await storage.loadPending();

  let accepted = 0, quarantined = 0;

  for (const b of burns) {
    const ts = (b.blockTime ? new Date(b.blockTime * 1000) : new Date()).toISOString();
    const base = {
      wallet: b.signer,
      tx: b.signature,
      amount: b.amount,
      ts,
      rawMemo: b.memo,
    };

    const parsed = parseMemo(b.memo);
    if (!parsed) {
      applyQuarantinedBurn(pending, base, 'memo_unparseable');
      if (!DRY_RUN) await storage.appendLog({ ...base, decision: 'quarantine', reason: 'memo_unparseable' });
      quarantined++; continue;
    }

    const result = filterMemo(parsed);
    if (!result.ok) {
      applyQuarantinedBurn(pending, { ...base, url: parsed.url, msg: parsed.msg }, result.reason);
      if (!DRY_RUN) await storage.appendLog({ ...base, decision: 'quarantine', reason: result.reason });
      quarantined++; continue;
    }

    applyAcceptedBurn(lb, {
      ...base,
      url: result.normalized.url,
      msg: result.normalized.msg,
    });
    if (!DRY_RUN) await storage.appendLog({ ...base, decision: 'accept', url: result.normalized.url });
    accepted++;
  }

  if (DRY_RUN) {
    log('dry-run: not writing files', { accepted, quarantined, newestSignature });
    return;
  }

  await storage.saveLeaderboard(lb);
  await storage.savePending(pending);
  await storage.saveState({ lastSignature: newestSignature });

  log('done', { accepted, quarantined, newestSignature });
}

main().catch(err => {
  log('fatal', { error: err.message, stack: err.stack });
  process.exitCode = 1;
});
