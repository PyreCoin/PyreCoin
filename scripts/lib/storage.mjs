// Repo-as-database storage for the ingest pipeline.
//
// Files we touch:
//   leaderboard.json        — accepted burns, served live
//   inscriptions.json       — accepted inscriptions (no PYRE burned)
//   pending.json            — quarantined entries (any type), never served
//   moderation-log.jsonl    — append-only audit of every ingest decision
//   state.json              — checkpoints (last seen sig per source)

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export class Storage {
  constructor(rootDir) {
    this.root = rootDir;
    this.paths = {
      leaderboard:  join(rootDir, 'leaderboard.json'),
      inscriptions: join(rootDir, 'inscriptions.json'),
      pending:      join(rootDir, 'pending.json'),
      log:          join(rootDir, 'moderation-log.jsonl'),
      state:        join(rootDir, 'state.json'),
    };
  }

  async readJson(path, fallback) {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf8'));
  }

  async writeJson(path, value) {
    await writeFile(path, JSON.stringify(value, null, 2) + '\n');
  }

  loadLeaderboard() {
    return this.readJson(this.paths.leaderboard, {
      updated: new Date(0).toISOString(),
      updatedBy: 'ingest-bot',
      solscanVerified: true,
      config: { gravity: 1.5, decayBaseHours: 2, topN: 16 },
      entries: [],
    });
  }

  loadInscriptions() {
    return this.readJson(this.paths.inscriptions, {
      updated: new Date(0).toISOString(),
      updatedBy: 'ingest-bot',
      // Newest-first chronological feed. Cap honored by the renderer
      // (last 50 displayed); older entries stay in the file as audit
      // trail until manually pruned.
      entries: [],
    });
  }

  loadPending() {
    return this.readJson(this.paths.pending, { entries: [] });
  }

  loadState() {
    // Two checkpoints: lastSignature for the mint-watching burn poller
    // (legacy field name kept for backwards compat), lastInscriptionSig
    // for the beacon-watching inscription poller.
    return this.readJson(this.paths.state, { lastSignature: null, lastInscriptionSig: null });
  }

  async saveLeaderboard(lb) {
    lb.updated = new Date().toISOString();
    lb.updatedBy = 'ingest-bot';
    await this.writeJson(this.paths.leaderboard, lb);
  }

  async saveInscriptions(ins) {
    ins.updated = new Date().toISOString();
    ins.updatedBy = 'ingest-bot';
    await this.writeJson(this.paths.inscriptions, ins);
  }

  async savePending(p) {
    await this.writeJson(this.paths.pending, p);
  }

  async saveState(s) {
    await this.writeJson(this.paths.state, s);
  }

  async appendLog(record) {
    await appendFile(
      this.paths.log,
      JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n'
    );
  }
}

// Apply a single accepted burn to the leaderboard. Each burn is its own
// entry — same wallet can appear multiple times. De-dup is by tx hash.
// Optional fields (url, msg, x) default to '' so legacy renderers that
// expect strings don't see undefined.
export function applyAcceptedBurn(lb, burn) {
  if (lb.entries.some(e => e.tx === burn.tx)) return lb;
  lb.entries.push({
    wallet: burn.wallet,
    url:    burn.url || '',
    msg:    burn.msg || '',
    x:      burn.x   || '',
    amount: burn.amount,
    ts:     burn.ts,
    tx:     burn.tx,
  });
  return lb;
}

// Apply an accepted inscription. No `amount` — inscriptions don't burn
// $PYRE. Newest-first ordering enforced by prepending here so the file
// stays sorted at write time and the renderer can read it directly.
export function applyAcceptedInscription(ins, record) {
  if (ins.entries.some(e => e.tx === record.tx)) return ins;
  ins.entries.unshift({
    wallet: record.wallet,
    url:    record.url || '',
    msg:    record.msg || '',
    x:      record.x   || '',
    ts:     record.ts,
    tx:     record.tx,
  });
  return ins;
}

export function applyQuarantinedBurn(p, burn, reason) {
  p.entries.push({
    kind:    'burn',
    wallet:  burn.wallet,
    rawUrl:  burn.url ?? null,
    rawMsg:  burn.msg ?? null,
    rawX:    burn.x   ?? null,
    rawMemo: burn.rawMemo ?? null,
    amount:  burn.amount,
    ts:      burn.ts,
    tx:      burn.tx,
    reason,
  });
  return p;
}

export function applyQuarantinedInscription(p, record, reason) {
  p.entries.push({
    kind:    'inscription',
    wallet:  record.wallet,
    rawUrl:  record.url ?? null,
    rawMsg:  record.msg ?? null,
    rawX:    record.x   ?? null,
    rawMemo: record.rawMemo ?? null,
    ts:      record.ts,
    tx:      record.tx,
    reason,
  });
  return p;
}
