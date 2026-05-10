# PYRE worker — RPC proxy + price history + analytics + ingest cron

Tiny Cloudflare Worker that does four jobs for `pyrecoin.com`:

| Path | Method | Purpose |
|---|---|---|
| `/` | POST | Solana mainnet RPC proxy (Helius) — used by the burn modal |
| `/price-history` | GET | Hourly OHLCV for the PYRE pool (GeckoTerminal), 5-min cache |
| `/analytics` | GET | Hourly visitor counts + top countries (CF GraphQL Web Analytics), 5-min cache |
| (cron) | scheduled | Pokes GitHub workflow_dispatch every 5 min to drive the ingest cron |

The worker holds every API key server-side. An origin allowlist + per-IP rate limit
gate the public endpoints so a harvested worker URL can't be used to drain quotas.

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

## `/price-history` — hourly OHLCV

Returns 240 hourly candles for the PYRE/SOL pool on pump-fun, sourced
from GeckoTerminal's free public API (no key required, 30 req/min
limit comfortably absorbed by the 5-min Cache API TTL).

**Response shape:**
```json
{
  "ohlcv": [[1778374800, 3.87e-6, 3.87e-6, 3.85e-6, 3.85e-6, 8.93], ...],
  "source": "geckoterminal",
  "pool": "6qtLrqwJu132JtMWTRzVymZJPkczbifzN9ejq4Lg5u2P"
}
```

Tuple order matches GeckoTerminal: `[unix_ts_seconds, open, high, low, close, volume_usd]`.
Newest-first (the frontend re-sorts ascending for left-to-right rendering).

The pool address lives in `wrangler.toml` `[vars] PYRE_POOL` — swap
the value if pump.fun ever migrates the pool to PumpSwap or Raydium.

## `/analytics` — hourly visits + top countries

Queries Cloudflare's GraphQL Analytics API for the Web Analytics
beacon's RUM dataset (`rumPageloadEventsAdaptiveGroups`). Single
GraphQL call returns both the hourly time series and the top
countries.

**Response shape:**
```json
{
  "hourlyVisits": [{ "tsSeconds": 1778374800, "count": 42 }, ...],
  "topCountries": [{ "label": "United States", "value": 1234 }, ...]
}
```

When the secrets aren't set, the response is the same shape with
empty arrays + a `note` field — the frontend renders an empty-state
placeholder rather than failing hard.

### One-time setup for analytics

1. **Add the beacon to the page.** Cloudflare → Web Analytics →
   "Add a site" → enter `pyrecoin.com`. Copy the **Site tag**.
   Paste it into `index.html` where the comment reads
   `REPLACE_WITH_BEACON_TOKEN`. Commit + deploy.

2. **Create a CF API token.** Cloudflare → My Profile → API Tokens →
   "Create Token" → Custom token. Permissions: **Account · Account
   Analytics · Read** (only). Account resources: include the account
   that owns pyrecoin.com. Save the token value — CF only shows it
   once.

3. **Find your CF Account ID.** Cloudflare dashboard → any zone
   overview → right sidebar → "Account ID". Copy it.

4. **Set the three worker secrets** (all from `worker/`, paste at
   the prompt — never as a command argument, per CLAUDE.md §7.12):

   ```bash
   npx wrangler secret put CF_ANALYTICS_TOKEN   # paste the API token
   npx wrangler secret put CF_ACCOUNT_ID        # paste the Account ID
   npx wrangler secret put CF_SITE_TAG          # paste the Site tag from step 1
   ```

5. **Deploy:**

   ```bash
   npx wrangler deploy
   ```

   Within ~5 min CF will start surfacing visitor data via the
   GraphQL API. The "By the Numbers" section auto-renders it on
   each refresh tick.

### Rotate the analytics token

```bash
cd worker
npx wrangler secret put CF_ANALYTICS_TOKEN
```

CF API tokens don't have a forced expiration but any compromise
(e.g. the token leaks via a log) calls for a rotation. The new value
takes effect on the next cache-miss request (worst case, 5 min
later).

### Diagnostics

If `/analytics` returns `note: "not configured"`, one of the three
secrets is missing. Verify with:

```bash
cd worker
npx wrangler secret list
```

If `/analytics` returns `502` with `detail` containing
`Authentication error` or `permission`, the API token is missing the
`Account.Account Analytics: Read` permission. Re-create with the
right scope and `secret put` again.

If `/analytics` returns `502` with an error mentioning `siteTag` or
empty results, double-check that the value pasted into
`CF_SITE_TAG` matches the **Site tag** in CF Web Analytics — same
value as the `data-cf-beacon` token in `index.html`.
