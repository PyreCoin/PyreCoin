#!/usr/bin/env node
// PYRE ingest pipeline — burns + inscriptions.
//
// Two sources, same moderation pipeline:
//
//   BURNS — getSignaturesForAddress(mint), accept Token-2022 burn /
//   burnChecked of our mint. Memo is optional (memo-less burns
//   surface with flavor text on the leaderboard).
//
//   INSCRIPTIONS — getSignaturesForAddress(INSCRIPTION_BEACON),
//   accept any tx with a Memo Program payload. The beacon is a PDA
//   derived from "pyrecoin:inscriptions:v1" against the PYRE mint;
//   no private key exists for it.
//
// Both flow through parseMemo → filterMemo. Pure burns (no memo)
// skip parse/filter and land on the leaderboard with empty url/msg/x.
//
// Idempotent: re-running is safe — checkpoints in state.json
// (lastSignature for burns, lastInscriptionSig for inscriptions) and
// per-tx-hash de-dup in applyAccepted*. Invoked by .github/workflows/
// ingest.yml on cron (dispatched by the CF Worker every 5 min —
// CLAUDE.md §7.13).

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  Storage,
  applyAcceptedBurn,
  applyAcceptedInscription,
  applyQuarantinedBurn,
  applyQuarantinedInscription,
} from './lib/storage.mjs';
import { parseMemo } from './lib/parse.mjs';
import { filterMemo } from './lib/filter.mjs';
import {
  fetchNewBurns,
  fetchNewInscriptions,
  fetchMintDecimals,
  makeConnection,
  INSCRIPTION_BEACON,
} from './lib/solana.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DRY_RUN = process.env.DRY_RUN === '1';

function log(msg, extra = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));
}

// Pure burn (no memo) → accepted directly with empty fields. The
// leaderboard renderer assigns a deterministic flavor quote at render
// time based on the tx hash, so we don't pin the quote to a particular
// memo at ingest time (lets the pool evolve without rewriting JSON).
async function processBurn(b, storage, lb, pending) {
  const ts = (b.blockTime ? new Date(b.blockTime * 1000) : new Date()).toISOString();
  const base = { wallet: b.signer, tx: b.signature, amount: b.amount, ts, rawMemo: b.memo };

  if (b.memo == null) {
    applyAcceptedBurn(lb, { ...base, url: '', msg: '', x: '' });
    if (!DRY_RUN) await storage.appendLog({ ...base, decision: 'accept', kind: 'burn_pure' });
    return 'accept';
  }

  const parsed = parseMemo(b.memo);
  if (!parsed) {
    applyQuarantinedBurn(pending, base, 'memo_unparseable');
    if (!DRY_RUN) await storage.appendLog({ ...base, decision: 'quarantine', reason: 'memo_unparseable' });
    return 'quarantine';
  }

  const result = filterMemo(parsed);
  if (!result.ok) {
    applyQuarantinedBurn(pending, { ...base, url: parsed.url, msg: parsed.msg, x: parsed.x }, result.reason);
    if (!DRY_RUN) await storage.appendLog({ ...base, decision: 'quarantine', reason: result.reason });
    return 'quarantine';
  }

  applyAcceptedBurn(lb, { ...base, ...result.normalized });
  if (!DRY_RUN) await storage.appendLog({ ...base, decision: 'accept', kind: 'burn', url: result.normalized.url });
  return 'accept';
}

// Inscriptions always have memos (extractInscription enforces this).
// Pure inscriptions (no metadata) have no reason to exist — the user
// is paying SOL specifically to write something on-chain.
async function processInscription(ins, storage, inscriptions, pending) {
  const ts = (ins.blockTime ? new Date(ins.blockTime * 1000) : new Date()).toISOString();
  const base = { wallet: ins.signer, tx: ins.signature, ts, rawMemo: ins.memo };

  const parsed = parseMemo(ins.memo);
  if (!parsed) {
    applyQuarantinedInscription(pending, base, 'memo_unparseable');
    if (!DRY_RUN) await storage.appendLog({ ...base, decision: 'quarantine', kind: 'inscription', reason: 'memo_unparseable' });
    return 'quarantine';
  }

  const result = filterMemo(parsed);
  if (!result.ok) {
    applyQuarantinedInscription(pending, { ...base, url: parsed.url, msg: parsed.msg, x: parsed.x }, result.reason);
    if (!DRY_RUN) await storage.appendLog({ ...base, decision: 'quarantine', kind: 'inscription', reason: result.reason });
    return 'quarantine';
  }

  applyAcceptedInscription(inscriptions, { ...base, ...result.normalized });
  if (!DRY_RUN) await storage.appendLog({ ...base, decision: 'accept', kind: 'inscription', url: result.normalized.url });
  return 'accept';
}

async function fetchAllRPC() {
  const mint = process.env.PYRE_MINT;
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!mint || !rpcUrl) {
    throw new Error('PYRE_MINT and SOLANA_RPC_URL are required (or set DRY_RUN=1)');
  }
  const storage = new Storage(ROOT);
  const state = await storage.loadState();
  const connection = makeConnection(rpcUrl);
  const max = Number(process.env.MAX_SIGNATURES || 500);

  // Decimals cached once; needed for plain-`burn` instructions that
  // don't carry a tokenAmount object.
  const decimals = await fetchMintDecimals(connection, mint);

  log('fetching burns', { mint, since: state.lastSignature, max });
  const burnResult = await fetchNewBurns({
    connection, mint,
    untilSignature: state.lastSignature,
    maxSignatures: max,
    decimals,
  });

  log('fetching inscriptions', { beacon: INSCRIPTION_BEACON, since: state.lastInscriptionSig, max });
  const insResult = await fetchNewInscriptions({
    connection,
    beacon: INSCRIPTION_BEACON,
    untilSignature: state.lastInscriptionSig,
    maxSignatures: max,
  });

  return {
    burns: burnResult.burns,
    newestBurnSig: burnResult.newestSignature,
    inscriptions: insResult.inscriptions,
    newestInscriptionSig: insResult.newestSignature,
    storage,
  };
}

function mockData() {
  const now = Math.floor(Date.now() / 1000);
  return {
    burns: [
      { signature: 'mock-burn-clean-' + now, slot: 0, blockTime: now, signer: 'MockA', amount: 12345, memo: 'url=cleanproject.xyz | msg=hello pyre' },
      { signature: 'mock-burn-pure-'  + now, slot: 0, blockTime: now, signer: 'MockB', amount: 6789,  memo: null },
      { signature: 'mock-burn-prof-'  + now, slot: 0, blockTime: now, signer: 'MockC', amount: 6789,  memo: 'url=example.com | msg=f*ck this' },
    ],
    inscriptions: [
      { signature: 'mock-ins-clean-' + now, slot: 0, blockTime: now, signer: 'MockD', memo: 'msg=just dropping in' },
      { signature: 'mock-ins-x-'     + now, slot: 0, blockTime: now, signer: 'MockE', memo: 'x=@alice_99 | msg=gm' },
    ],
    newestBurnSig: 'mock-newest-burn-' + now,
    newestInscriptionSig: 'mock-newest-ins-' + now,
    storage: new Storage(ROOT),
  };
}

async function main() {
  const data = DRY_RUN ? mockData() : await fetchAllRPC();
  const { burns, inscriptions, newestBurnSig, newestInscriptionSig, storage } = data;

  log('to process', { burns: burns.length, inscriptions: inscriptions.length });

  const lb       = await storage.loadLeaderboard();
  const insStore = await storage.loadInscriptions();
  const pending  = await storage.loadPending();

  let burnAccepted = 0, burnQuarantined = 0;
  for (const b of burns) {
    const decision = await processBurn(b, storage, lb, pending);
    if (decision === 'accept') burnAccepted++;
    else burnQuarantined++;
  }

  let insAccepted = 0, insQuarantined = 0;
  for (const ins of inscriptions) {
    const decision = await processInscription(ins, storage, insStore, pending);
    if (decision === 'accept') insAccepted++;
    else insQuarantined++;
  }

  if (DRY_RUN) {
    log('dry-run: not writing files', {
      burnAccepted, burnQuarantined, insAccepted, insQuarantined,
      newestBurnSig, newestInscriptionSig,
    });
    return;
  }

  await storage.saveLeaderboard(lb);
  await storage.saveInscriptions(insStore);
  await storage.savePending(pending);
  await storage.saveState({
    lastSignature: newestBurnSig,
    lastInscriptionSig: newestInscriptionSig,
  });

  log('done', { burnAccepted, burnQuarantined, insAccepted, insQuarantined, newestBurnSig, newestInscriptionSig });
}

main().catch(err => {
  log('fatal', { error: err.message, stack: err.stack });
  process.exitCode = 1;
});
