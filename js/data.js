// ─── SHARED DATA LAYER ───────────────────────────────────────────────
// Single source of truth for leaderboard.json + inscriptions.json.
// All renderers (leaderboard, inscription wall, stats) read from here so
// each tick pulls each file at most once.
//
// Failure mode: a failed fetch leaves the previous cache in place. The
// only way to get an empty array out of getEntries() / getInscriptions()
// is for the very first fetch to fail before any successful one.
//
// 10 second TTL: comfortably below the 30 s render cadence, so all
// consumers in the same tick share a single network round-trip; but new
// ticks always re-fetch.
const TTL_MS = 10_000;

// State lives on globalThis (see prior note in this file — the dynamic-
// import-with-?v= specifier resolves to a different module instance than
// static imports of the same path, so module-level `let` is per-specifier
// and silently splits state).
const _state = (globalThis.__pyreData ||= {
  entries:      [], lastFetch:      0, inflight:      null,
  inscriptions: [], lastFetchIns:   0, inflightIns:   null,
});

async function _fetchOnce(file, cacheKey, lastFetchKey, inflightKey, listKey) {
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
  return _fetchOnce('./leaderboard.json', 'lb', 'lastFetch', 'inflight', 'entries');
}
export function getEntries() { return _state.entries; }

export async function refreshInscriptions() {
  return _fetchOnce('./inscriptions.json', 'ins', 'lastFetchIns', 'inflightIns', 'inscriptions');
}
export function getInscriptions() { return _state.inscriptions; }
