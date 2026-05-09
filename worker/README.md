# PYRE RPC proxy worker

Tiny Cloudflare Worker that proxies Solana mainnet RPC calls from
`pyrecoin.com` to Helius. The browser-side burn modal calls this
worker; the worker holds the Helius API key server-side and enforces
an origin allowlist so third parties can't use the endpoint even if
they harvest the worker URL from page source.

## One-time setup

```bash
cd worker
npm i -g wrangler                   # if not already installed
wrangler login                      # browser OAuth — opens a tab
wrangler secret put HELIUS_KEY      # paste Helius Free Key B
wrangler deploy                     # outputs the public worker URL
```

After deploy, the worker is live at:
`https://pyre-rpc-proxy.<your-cf-subdomain>.workers.dev`

Update `js/config.js` `RPC_URL` to point at that URL (or set up a
custom subdomain like `rpc.pyrecoin.com` via Cloudflare DNS for
brand cleanliness).

## Subsequent deploys

```bash
cd worker
wrangler deploy
```

## Rotating the Helius key

```bash
wrangler secret put HELIUS_KEY
```

The new key takes effect immediately on the next request. No code
change needed.

## Ingest cron trigger

This worker also runs a 5-minute scheduled handler that pokes
GitHub's `workflow_dispatch` endpoint on the ingest workflow.
GH Actions free-tier `schedule:` is best-effort and was observed
delaying 1–3 hours per run during normal load — unworkable for a
memecoin where burn-to-leaderboard latency is part of the UX.
CF Worker cron fires reliably.

### One-time setup (in addition to the RPC proxy setup above)

1. Create a fine-grained PAT at
   https://github.com/settings/personal-access-tokens/new
   - Resource owner: `PyreCoin`
   - Repository access: only `PyreCoin/PyreCoin`
   - Permissions → Actions: **Read and write**
   - Expiration: 90 days (set a calendar reminder)

2. Set as worker secret and deploy:
   ```bash
   wrangler secret put GITHUB_PAT
   wrangler deploy
   ```

### Verify

Within ~5 min of deploy you should see new ingest runs:

```bash
gh run list --workflow="Ingest burns" --limit 5
```

Cadence should now be every 5 minutes (vs. the prior 1–3hr gaps).

### Rotate the PAT (every 90 days)

```bash
wrangler secret put GITHUB_PAT
```

The new PAT takes effect immediately on the next cron tick.

## Free tier limits

- 100,000 requests/day (resets at UTC midnight)
- 10ms CPU per request (we use ~5ms — single fetch + small JSON pass-through)
- No bandwidth cap
- 30s wall-clock per request

If we ever exceed 100K req/day, requests start returning 429 from
Cloudflare's edge until the next quota window. The fallback in
`burn.js` would then need to either retry directly against Helius
(losing the origin protection) or surface a "try again in a moment"
message — not implemented yet.
