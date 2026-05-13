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
// Stable constants (the Memo Program ID, Jupiter endpoints, the SOL
// wrapped-mint) stay in this file — they're properties of Solana
// itself, not project state, and don't change.

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
// Burns are done via Token-2022 BurnChecked (see js/burn.js); no
// destination address is involved. Memo Program is unchanged.
export const MEMO_PROGRAM_ID_STR = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

// Inscription beacon. PDA derived from "pyrecoin:inscriptions:v1"
// against the PYRE mint — off-curve, no private key exists for it.
// Free-SOL inscriptions transfer 1 lamport here + a Memo Program
// payload; the ingest cron lists getSignaturesForAddress(BEACON)
// to find them. Anyone can replicate this shape from any wallet.
// See scripts/lib/solana.mjs INSCRIPTION_BEACON for the same value.
export const INSCRIPTION_BEACON_STR = '2yqR9bjy64UqnWYP4wTrpw8RwFqXGQnkhzQRSp11MmDi';

// Pump.fun creates SPL tokens with a fixed 1B (uiAmount) initial supply.
// We compute the "PYRE Burned" stat as INITIAL_SUPPLY − getTokenSupply()
// rather than summing leaderboard entries — supply is the chain's source
// of truth, doesn't lag the ingest cron, and surfaces every BurnChecked
// the moment it confirms.
export const INITIAL_SUPPLY = 1_000_000_000;

// PYRE genesis — the precise moment the pump.fun mint instruction
// confirmed and the token entered the world. Used by the "Genesis"
// stat card to render the absolute date + the live "N days ago"
// relative time. Date.UTC's month arg is 0-indexed (April = 3, May = 4).
export const GENESIS_TS_MS = Date.UTC(2026, 4, 9, 3, 43, 59);

export const isPlaceholder = () => PYRE_MINT_STR.startsWith('PYREMIN');

// Wrapped-SOL mint. The constant Solana cooked into its protocol; never
// changes. Used by the buy form, atomic-burn (Jupiter swap-source key)
// and main.js (CTA price line).
export const SOL_MINT_STR = 'So11111111111111111111111111111111111111112';

// Jupiter Swap V1 endpoints. lite-api.jup.ag is the free, keyless,
// CORS-permissive variant; api.jup.ag denies cross-origin browser
// requests without an x-api-key header. Pricing path is v3.
export const JUP = Object.freeze({
  QUOTE:              'https://lite-api.jup.ag/swap/v1/quote',
  SWAP:               'https://lite-api.jup.ag/swap/v1/swap',
  SWAP_INSTRUCTIONS:  'https://lite-api.jup.ag/swap/v1/swap-instructions',
  PRICE:              'https://lite-api.jup.ag/price/v3',
});

// Jupiter swap defaults shared by the buy form and the atomic-burn
// builder. 3% static slippage with dynamicSlippage=true is the
// memecoin-floor combination — 1% fails constantly on illiquid pools.
// MAX_PRIORITY_LAMPORTS is the hard ceiling on the priority fee per
// swap (0.002 SOL ≈ $0.40 at $200 SOL).
export const SWAP_DEFAULTS = Object.freeze({
  SLIPPAGE_BPS:          300,
  MAX_PRIORITY_LAMPORTS: 2_000_000,
});

// Solana fee defaults for the direct-burn path. Base fee is 5,000
// lamports per signature; we tack on a small priority fee for fast
// inclusion. BEACON_LAMPORTS is the marker amount transferred to the
// inscription beacon (an off-curve PDA — irrecoverable, intentionally).
// INSCRIPTION_FEE_LAMPORTS is the bare-minimum SOL cost of an
// inscription (base + priority + beacon). Used by the CTA cost line.
export const BASE_LAMPORTS = 5_000;
export const PRIORITY_LAMPORTS = 10_000;
export const BEACON_LAMPORTS = 1;
export const INSCRIPTION_FEE_LAMPORTS = BASE_LAMPORTS + PRIORITY_LAMPORTS + BEACON_LAMPORTS;

// Stablecoin mints kept here so the buy form, atomic-burn module, and
// burn.js bill-of-sale all reference the same canonical mint strings.
// Pump.fun creates Token-2022 mints; USDC/USDT are legacy SPL.
export const USDC_MINT_STR = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT_STR = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
