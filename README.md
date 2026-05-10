# 🔥 PYRE — Burn to Be Seen

**[pyrecoin.com](https://pyrecoin.com)** | [@PYREcoin](https://x.com/PYREcoin) | [pump.fun](https://pump.fun/coin/64QkPGe9mHHMTByEJoDgPjoJKzLqZgEGX8xW7o1rpump) | [Jupiter](https://jup.ag/tokens/64QkPGe9mHHMTByEJoDgPjoJKzLqZgEGX8xW7o1rpump) | [DexScreener](https://dexscreener.com/solana/64QkPGe9mHHMTByEJoDgPjoJKzLqZgEGX8xW7o1rpump)

> A Solana memecoin with a single mechanic: burn $PYRE to put your URL
> on a public leaderboard ranked by **time-decayed heat**. Old burns
> fade. Fresh burns climb. Feed the pyre to stay on top.

---

## What is $PYRE?

$PYRE is a Solana memecoin (a *digital collectible* under the SEC/CFTC
joint guidance of March 17, 2026). The site at [pyrecoin.com](https://pyrecoin.com) is a
public, on-chain billboard: anyone can burn $PYRE with a memo
containing a URL and a message, and the leaderboard renders the top 16
slots ranked by heat.

## How heat works

Each burn is its own slot — its own URL, its own message, its own
timestamp, its own on-chain receipt. Same wallet can hold many slots
at once. Each slot's heat is:

```
heat(slot) = amount / (hours_since_burn + 2)^1.5
```

This is the Hacker News / Reddit "hot" formula, applied to fire.
Concretely:

- A 100,000 burn at t=0 has heat ≈ 35,000.
- The same burn 24 hours later has heat ≈ 760.
- A fresh 5,000 burn one hour after the original has heat ≈ 960 — it
  outranks a day-old whale by a hair.

There is no permanent rank. Whales must keep burning to keep their
slot. Fresh small burns can take a top-16 position for the cost of a
bus ticket. Rank 1 gets the sponsored hero card above the fold;
ranks 2–16 the live leaderboard; ranks 17+ the backburner.

## How to participate

1. **Buy $PYRE** on pump.fun.
2. **Burn through [pyrecoin.com](https://pyrecoin.com).** The site's burn modal builds a
   Token-2022 `BurnChecked` instruction (which destroys the tokens at
   the protocol layer — supply actually decreases) plus a Memo Program
   instruction in the same transaction. Memo format:
   ```
   url=yoursite.xyz | msg=your message
   ```
   Advanced users can construct the same transaction directly via the
   SPL CLI or any Solana SDK — the indexer watches the mint account
   for `Burn`/`BurnChecked` instructions, so any such transaction
   carrying a valid memo qualifies.
3. **Wait** — the pipeline picks up new burns from the chain on a
   ~5–10 minute cadence and (if your memo passes the moderation
   filter) updates `leaderboard.json` automatically.
4. **Your slot goes live** on the next page rebuild.

## Token

- **Chain:** Solana
- **Launched via:** pump.fun (Token-2022)
- **Mint:** `64QkPGe9mHHMTByEJoDgPjoJKzLqZgEGX8xW7o1rpump`
- **Burn mechanic:** Token-2022 `BurnChecked` instruction — the
  protocol destroys the tokens and the mint's total supply decreases
  by the burned amount. Aggregators (Jupiter, DexScreener, Birdeye,
  Solscan) reflect the reduction directly; the deflationary claim is
  verifiable from any indexer.

## Architecture

This repo *is* the leaderboard backend. There is no server, no
database, no account system.

- `index.html` — landing page, leaderboard renderer, etymology.
- `leaderboard.json` — list of accepted entries (one per burn — same
  wallet can appear multiple times, each row carrying its own memo).
- `pending.json` — quarantined entries flagged by the moderation
  filter (never rendered on the live page).
- `moderation-log.jsonl` — append-only audit log of every ingest
  decision.
- (Coming) `.github/workflows/ingest.yml` — scheduled job that polls
  Solana RPC, parses memos, runs the deterministic filter, and
  commits.

GitHub Pages serves the page. Every commit triggers a rebuild.

## Mechanics, in plain terms

- **Deflationary by construction.** Every burn permanently removes
  tokens from supply. There is no minting after launch.
- **No team-dependent features.** Ranking is fully programmatic. There
  is no roadmap of "team will deliver X by Y" — there is one mechanic
  and that's the product.
- **No custody, no PII.** The site does not hold funds and does not
  collect personal information.

## Rules

See [the rules section](https://pyrecoin.com#rules) on the site, or
[CONTRIBUTING.md](CONTRIBUTING.md) for the moderation pipeline. The
short version: legal content only, no hate, no NSFW, deterministic
filter + reactive human removal.

## Compliance

$PYRE is treated as a "digital collectible" under the SEC/CFTC joint
interpretive release of March 17, 2026 (Release Nos. 33-11412;
34-105020) — generally not a security when purchased for entertainment
or cultural purposes. Site copy avoids price predictions, return
promises, and team-execution roadmaps. The moderation pipeline is
deterministic-first (NFKC + URL safety + wordlist) with reactive
human takedown for illegal content.

## Disclaimer

$PYRE is a memecoin — a digital collectible under the SEC/CFTC joint
guidance of March 17, 2026. It is not a security, not an investment,
and not a yield product. This page does not constitute financial
advice. Burn responsibly, or at least loudly.
