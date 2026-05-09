// ─── CONFIG ──────────────────────────────────────────────────────────
// Two lines change between devnet test and mainnet production:
//   PYRE_MINT_STR — the SPL token mint
//   RPC_URL       — which Solana cluster to talk to
//
// PRODUCTION (after pump.fun launch):
//   PYRE_MINT_STR = '<the mint address pump.fun gives you>'
//   RPC_URL       = 'https://api.mainnet-beta.solana.com'  (or Helius for higher limits)
//
// DEVNET DRY-RUN (recommended before launch — free, no risk):
//   solana config set --url devnet
//   solana airdrop 2
//   spl-token create-token --decimals 6        → copy the mint
//   spl-token create-account <mint>
//   spl-token mint <mint> 1000000
//   Then set:
//     PYRE_MINT_STR = '<your devnet mint>'
//     RPC_URL       = 'https://api.devnet.solana.com'
//   Switch Phantom to Devnet (Settings → Developer settings → Testnet mode).
//   Verify burns on https://solscan.io/?cluster=devnet
//
// Mainnet mint, set at pump.fun launch on 2026-05-09.
export const PYRE_MINT_STR = '64QkPGe9mHHMTByEJoDgPjoJKzLqZgEGX8xW7o1rpump';
// Browser-side RPC.
//
// Routes through a Cloudflare Worker proxy (worker/src/index.js) at
// rpc.pyrecoin.com. The worker holds Helius Free Key B in an
// encrypted env binding and enforces an Origin allowlist
// (pyrecoin.com only), so the key never appears in client source
// and third parties scraping page source can't use the endpoint.
// The cron's Helius key (Key A) stays in its own GH-Actions-secret
// silo, isolated from any browser-side abuse. See memory:
// rpc-endpoint-strategy.
//
// History: originally api.mainnet-beta.solana.com (public, no key).
// Solana Foundation began returning 403 to browser-origin calls in
// 2026-05; we briefly tried embedding the Helius key directly in
// source (lazy/insecure), then moved to this worker proxy instead.
export const RPC_URL = 'https://rpc.pyrecoin.com';
export const BURN_OWNER_STR = '11111111111111111111111111111111'; // Solana null
export const MEMO_PROGRAM_ID_STR = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export const isPlaceholder = () => PYRE_MINT_STR.startsWith('PYREMINT');
