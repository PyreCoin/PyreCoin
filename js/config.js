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
// The burn button refuses to submit while PYRE_MINT_STR is the
// placeholder, so it's safe to ship with the placeholder until launch.
export const PYRE_MINT_STR = 'PYREMINTADDRESSGOESHEREAFTERPUMPFUNLAUNCH00';
export const RPC_URL = 'https://api.mainnet-beta.solana.com';
export const BURN_OWNER_STR = '11111111111111111111111111111111'; // Solana null
export const MEMO_PROGRAM_ID_STR = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export const isPlaceholder = () => PYRE_MINT_STR.startsWith('PYREMINT');
