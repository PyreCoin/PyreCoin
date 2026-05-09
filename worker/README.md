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
