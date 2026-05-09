// ─── CONFIG ──────────────────────────────────────────────────────────
//
// Volatile values (mint address, RPC endpoint) are fetched from
// /runtime-config.json on module load with cache: 'no-store' so the
// browser always goes to network for fresh values. This bypasses
// GitHub Pages's default 10-min max-age cache for these specific
// values — without it, a returning visitor with a sticky tab could
// continue calling the previous RPC URL or reading the previous mint
// for up to 10 minutes after a deploy.
//
// Top-level await pauses every module that imports this file until
// runtime-config.json resolves, so all downstream callers
// (stats.js, leaderboard.js, burn.js) see consistent values.
//
// Stable constants (the Solana null address, the Memo Program ID)
// stay in this file — they're properties of Solana itself, not
// project state, and don't change.

async function fetchRuntimeConfig() {
  try {
    const res = await fetch('./runtime-config.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const cfg = await res.json();
    if (typeof cfg?.pyreMintStr !== 'string' || typeof cfg?.rpcUrl !== 'string') {
      throw new Error('runtime-config.json: missing required fields');
    }
    return cfg;
  } catch (err) {
    // Failure mode: render the placeholder/empty state safely. Better
    // than crashing the whole bundle. The leaderboard renders an empty
    // state when isPlaceholder() is true, the burn button refuses to
    // submit, and stats render zeros + '—'.
    console.error('runtime-config.json load failed:', err);
    return {
      pyreMintStr: 'PYREMINTADDRESSGOESHEREAFTERPUMPFUNLAUNCH00',
      rpcUrl: '',
    };
  }
}

const _cfg = await fetchRuntimeConfig();

export const PYRE_MINT_STR = _cfg.pyreMintStr;
export const RPC_URL       = _cfg.rpcUrl;
export const BURN_OWNER_STR     = '11111111111111111111111111111111'; // Solana null
export const MEMO_PROGRAM_ID_STR = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export const isPlaceholder = () => PYRE_MINT_STR.startsWith('PYREMINT');
