// ─── SHARED DATA LAYER ───────────────────────────────────────────────
// Single source of truth for `leaderboard.json`. Both the leaderboard
// renderer and the stats panel read from here, so each 30-second tick
// pulls the file once instead of twice.
//
// Before this module existed, leaderboard.js and stats.js each did
// their own fetch on init / refresh. Worse, leaderboard.js only fetched
// ONCE at module load and never re-fetched, so new burns surfaced in
// the stats cards but didn't appear on the live board until the user
// reloaded the page. Fixing both bugs here.
//
// API:
//   refreshEntries()  → async, fetches if cache is older than TTL,
//                       returns the (possibly cached) array
//   getEntries()      → sync, returns the last cached array (or [])
//
// Failure mode: a failed fetch leaves the previous cache in place. The
// only way to get an empty array out of getEntries() is for the very
// first fetch to fail before any successful one — same behavior the
// old per-module fetchers exhibited.
//
// 10 second TTL: comfortably below the 30 s render cadence, so the
// in-tick second consumer (stats after leaderboard, or vice versa)
// always shares a single network round-trip; but new ticks always
// re-fetch.
const TTL_MS = 10_000;

let _entries   = [];
let _lastFetch = 0;
let _inflight  = null;

export async function refreshEntries() {
  if (Date.now() - _lastFetch < TTL_MS && _entries.length > 0) return _entries;
  // Coalesce concurrent callers onto a single in-flight request so
  // back-to-back consumers in the same tick don't double-fire the
  // network call before TTL is set.
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const res = await fetch('./leaderboard.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (data && Array.isArray(data.entries)) _entries = data.entries;
      _lastFetch = Date.now();
    } catch (_) {
      // Keep stale entries on failure rather than blanking the UI.
    } finally {
      _inflight = null;
    }
    return _entries;
  })();
  return _inflight;
}

export function getEntries() {
  return _entries;
}
