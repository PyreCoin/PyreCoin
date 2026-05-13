// ─── SHARED DATA LAYER ───────────────────────────────────────────────
// Single source of truth for:
//   1. leaderboard.json + inscriptions.json fetch caches (TTL'd)
//   2. RPC Connection singleton (one per page — RPC_URL is fixed at
//      module-load by config.js)
//   3. PYRE mint decimals (one chain round-trip cached forever — the
//      decimals on a Token-2022 mint can't change once set)
//
// All renderers (leaderboard, inscription wall, stats) read from here
// so each tick pulls each file at most once.
//
// Failure mode: a failed fetch leaves the previous cache in place. The
// only way to get an empty array out of getEntries() / getInscriptions()
// is for the very first fetch to fail before any successful one.
//
// 10 second TTL: comfortably below the 30 s render cadence, so all
// consumers in the same tick share a single network round-trip; but new
// ticks always re-fetch.

import { Connection, PublicKey } from '../vendor/web3.mjs';
import { PYRE_MINT_STR, RPC_URL } from './config.js';

const TTL_MS = 10_000;

// State lives on globalThis (see prior note in this file — the dynamic-
// import-with-?v= specifier resolves to a different module instance than
// static imports of the same path, so module-level `let` is per-specifier
// and silently splits state).
const _state = (globalThis.__pyreData ||= {
  entries:      [], lastFetch:      0, inflight:      null,
  inscriptions: [], lastFetchIns:   0, inflightIns:   null,
  conn:         null,
  pyreDecimals: null,
  pyreDecimalsPromise: null,
});

async function _fetchOnce(file, lastFetchKey, inflightKey, listKey) {
  if (Date.now() - _state[lastFetchKey] < TTL_MS && _state[listKey].length > 0) return _state[listKey];
  if (_state[inflightKey]) return _state[inflightKey];
  _state[inflightKey] = (async () => {
    try {
      const res = await fetch(file, { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data && Array.isArray(data.entries)) _state[listKey] = data.entries;
      _state[lastFetchKey] = Date.now();
    } catch (_) {
      // Keep stale list on failure rather than blanking the UI.
    } finally {
      _state[inflightKey] = null;
    }
    return _state[listKey];
  })();
  return _state[inflightKey];
}

export async function refreshEntries() {
  return _fetchOnce('./leaderboard.json', 'lastFetch', 'inflight', 'entries');
}
export function getEntries() { return _state.entries; }

export async function refreshInscriptions() {
  return _fetchOnce('./inscriptions.json', 'lastFetchIns', 'inflightIns', 'inscriptions');
}
export function getInscriptions() { return _state.inscriptions; }

// Singleton Connection for the page. RPC_URL doesn't change after the
// runtime-config.json fetch in config.js resolves; constructing a fresh
// Connection per call (the old burn.js pattern) just allocated objects.
export function getConnection() {
  if (!_state.conn) _state.conn = new Connection(RPC_URL, 'confirmed');
  return _state.conn;
}

// PYRE mint decimals. One round-trip per page, cached afterward (and
// shared between burn.js's direct-PYRE path, atomic-burn.js's swap
// builder, and buy.js's output rendering). Returns Number.
//
// In-flight de-dup: multiple callers awaiting before the first fetch
// returns share the same Promise instead of triggering N round-trips.
export async function getPyreDecimals() {
  if (_state.pyreDecimals != null) return _state.pyreDecimals;
  if (_state.pyreDecimalsPromise) return _state.pyreDecimalsPromise;
  _state.pyreDecimalsPromise = (async () => {
    const conn = getConnection();
    const info = await conn.getParsedAccountInfo(new PublicKey(PYRE_MINT_STR));
    const d = info?.value?.data?.parsed?.info?.decimals;
    if (typeof d !== 'number') throw new Error('Could not read PYRE decimals');
    _state.pyreDecimals = d;
    return d;
  })().finally(() => { _state.pyreDecimalsPromise = null; });
  return _state.pyreDecimalsPromise;
}
