// Repo-as-database storage for the ingest pipeline.
//
// Files we touch:
//   leaderboard.json        — accepted entries, served live
//   pending.json            — quarantined (filter-failed) entries, never served
//   moderation-log.jsonl    — append-only audit log of every ingest decision
//   state.json              — checkpoint (last seen signature)

import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export class Storage {
  constructor(rootDir) {
    this.root = rootDir;
    this.paths = {
      leaderboard: join(rootDir, 'leaderboard.json'),
      pending: join(rootDir, 'pending.json'),
      log: join(rootDir, 'moderation-log.jsonl'),
      state: join(rootDir, 'state.json'),
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

  loadPending() {
    return this.readJson(this.paths.pending, { entries: [] });
  }

  loadState() {
    return this.readJson(this.paths.state, { lastSignature: null });
  }

  async saveLeaderboard(lb) {
    lb.updated = new Date().toISOString();
    lb.updatedBy = 'ingest-bot';
    await this.writeJson(this.paths.leaderboard, lb);
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

// Apply a single accepted burn to the leaderboard. Aggregates by wallet:
// the wallet's burns array gains a new entry, and the latest memo wins for
// the displayed url + msg.
export function applyAcceptedBurn(lb, burn) {
  let entry = lb.entries.find(e => e.wallet === burn.wallet);
  if (!entry) {
    entry = {
      wallet: burn.wallet,
      url: burn.url,
      msg: burn.msg,
      burns: [],
    };
    lb.entries.push(entry);
  } else {
    // Latest memo replaces displayed values
    entry.url = burn.url;
    entry.msg = burn.msg;
  }
  // Avoid duplicate ingestion of the same tx
  if (!entry.burns.some(b => b.tx === burn.tx)) {
    entry.burns.push({ amount: burn.amount, ts: burn.ts, tx: burn.tx });
  }
  return lb;
}

export function applyQuarantinedBurn(p, burn, reason) {
  p.entries.push({
    wallet: burn.wallet,
    rawUrl: burn.url ?? null,
    rawMsg: burn.msg ?? null,
    rawMemo: burn.rawMemo ?? null,
    amount: burn.amount,
    ts: burn.ts,
    tx: burn.tx,
    reason,
  });
  return p;
}
