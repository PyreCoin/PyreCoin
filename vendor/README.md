# Vendored browser dependencies

Self-contained ESM bundles of the three Solana libraries the frontend needs
at runtime. Each is bundled from the official npm package via esbuild on a
trusted local machine and committed here so the deployed site has zero
runtime CDN dependencies. No `esm.sh`, no `jsdelivr`, no other third party
in the supply chain.

## Versions

| Bundle                 | Package              | Version | npm published  |
|------------------------|----------------------|---------|----------------|
| `web3.mjs`             | `@solana/web3.js`    | 1.98.4  | 2025-07-31     |
| `spl-token.mjs`        | `@solana/spl-token`  | 0.4.14  | 2025-09-02     |
| `wallet-standard.mjs`  | `@wallet-standard/app` | 1.1.0 | 2024-10-30     |

`spl-token.mjs` is built with `@solana/web3.js` marked as `external` and
its import is patched to `./web3.mjs`, so the two bundles share one
runtime copy of web3 — single `PublicKey` class, no `instanceof` drift,
no duplicate bytes shipped to the browser.

## SHA-384 hashes

```
web3.mjs            sha384-TkssWdOXzFgvq3pQCrjkYY0ZrTeAVZpNpTPqvP64MaSsgJgheUYpHLyz55BGJc3M
spl-token.mjs       sha384-vBk4ODjHMatMq18XxkWHKhXiE+JmIzYvB4InzYzRB2L6asxC3T/7/xXUvo+9UllV
wallet-standard.mjs sha384-4a5T1vIp45ddoDk5yiJZSGZIPvQJGX/i65hYpE9P/rFMceqab6bMiDaymeuPZfWJ
```

Recompute with:

```bash
for f in vendor/web3.mjs vendor/spl-token.mjs vendor/wallet-standard.mjs; do
  hash=$(openssl dgst -sha384 -binary "$f" | base64)
  echo "$f → sha384-$hash"
done
```

## Rebuilding

Source entry files live in `_src/`. To rebuild after a dependency bump:

```bash
npm install --save-dev \
  @solana/web3.js@<version> \
  @solana/spl-token@<version> \
  @wallet-standard/app@<version>

# web3.js and wallet-standard: simple single-file bundle.
node_modules/.bin/esbuild vendor/_src/web3.js \
  --bundle --format=esm --platform=browser --target=es2020 \
  --minify --legal-comments=none --outfile=vendor/web3.mjs

node_modules/.bin/esbuild vendor/_src/wallet-standard.js \
  --bundle --format=esm --platform=browser --target=es2020 \
  --minify --legal-comments=none --outfile=vendor/wallet-standard.mjs

# spl-token: web3.js marked external; the import string is then patched
# to point at the vendored sibling.
node_modules/.bin/esbuild vendor/_src/spl-token.js \
  --bundle --format=esm --platform=browser --target=es2020 \
  --minify --legal-comments=none \
  --external:@solana/web3.js \
  --outfile=vendor/spl-token.mjs
sed -i 's|@solana/web3.js|./web3.mjs|g' vendor/spl-token.mjs
```

Then refresh the SHA-384 table above and bump the cache-bust `V` in
`index.html` + `js/main.js`.

## Why vendor at all

GitHub Pages serves these from the same origin as the rest of the site,
so:

- Zero new third-party in the network panel
- Same cache headers as everything else (no surprise CDN max-age)
- One less DNS/TLS connection on cold-load
- If `esm.sh` ever changes its transform or has a bad cache, our site
  is unaffected
- Supply chain attack surface is reduced to: did we trust the npm
  publisher when we bundled? (Same trust model as any `npm install`.)

The tradeoff is bundle size (~580 KB across three files). Cached after
the first load.
