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
// Browser-side RPC. Originally we used Solana Foundation's public
// mainnet endpoint (api.mainnet-beta.solana.com) so no API key would
// live in source. As of 2026-05 that endpoint started returning 403
// to browser-origin getAccountInfo calls — confirmed live by the
// burn-button balance fetch failing during the inaugural burn attempt.
//
// Switched to Helius Free (Key B — the spare key from the launch
// playbook). Key A stays dedicated to the GitHub Actions ingest cron
// (in an encrypted GH secret) so browser abuse can't drain the cron's
// quota. Helius Free has no per-key origin restrictions, so this key
// is harvestable from page source and could be abused by third parties;
// the worst case is browser visitors get rate-limited until the next
// quota window. Cron continues independently.
//
// If Solana Foundation reopens public mainnet to browser calls in the
// future, we can revert. See memory: rpc-endpoint-strategy.
export const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=329308ce-fbcc-4197-be64-451d18fadb39';
export const BURN_OWNER_STR = '11111111111111111111111111111111'; // Solana null
export const MEMO_PROGRAM_ID_STR = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export const isPlaceholder = () => PYRE_MINT_STR.startsWith('PYREMINT');
