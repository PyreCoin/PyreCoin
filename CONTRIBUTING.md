# Contributing to PYRE

Most updates happen automatically. The pipeline polls Solana, parses
memos, and commits to `leaderboard.json` without human intervention.
Humans get involved only for moderation edge cases and code changes.

## How burns become leaderboard entries

```
on-chain burn  →  RPC poll  →  memo parse  →  deterministic filter  →
  ┌─ pass → leaderboard.json (auto-commit, page rebuilds)
  └─ fail → pending.json (quarantined, never rendered)
```

Every decision is logged in `moderation-log.jsonl` (append-only).

## Burn memo format

Send $PYRE to `11111111111111111111111111111111` with a memo of the
form:

```
url=yoursite.xyz | msg=your message goes here
```

Constraints (enforced by the ingest filter):

- URL ≤ 200 chars; must be HTTPS-resolvable; no link shorteners; no
  IP literals; no `javascript:` / `data:` / similar schemes
- Message ≤ 280 chars
- Unicode normalized via NFKC; no control chars, RTL overrides, or
  zero-width chars
- No homograph abuse (Cyrillic letters in Latin-script URLs etc.)
- Profanity wordlist applied (English + common variants)

A wallet's burns are aggregated under one slot. Latest memo replaces
the displayed message. Burn amounts contribute to heat with time
decay (formula in the README).

## Data shape

`leaderboard.json` (per-wallet, accepted entries):

```jsonc
{
  "updated": "2026-05-08T14:00:00Z",
  "config": { "gravity": 1.5, "decayBaseHours": 2 },
  "entries": [
    {
      "wallet": "7xKmP...f3Rq",
      "url": "moonfi.xyz",
      "msg": "Daily alpha calls.",
      "burns": [
        { "amount": 300000, "ts": "2026-05-06T22:00:00Z", "tx": "3nZ9x...8kLm" },
        { "amount": 120000, "ts": "2026-05-07T18:00:00Z", "tx": "3nZ9x...9aBc" }
      ]
    }
  ]
}
```

The page sorts by computed heat at render time, takes the top 16, and
re-ranks every 30s while the page is open.

## Reporting bad content

Open an issue with the tx hash and a one-line reason. A maintainer
will move the entry into `pending.json` (or remove it permanently if
illegal) within minutes. The chain receipt remains; the rendered slot
does not.

Categories that get pulled immediately:

- Hate speech, slurs, dog whistles
- Illegal content, scams, fraud, counterfeit goods
- NSFW / adult content
- Impersonation without obvious parody context
- CSAM, doxing, threats, terrorism content (always escalated, evidence
  preserved, lawful requests honored)

## Code contributions

- Anything touching user-facing copy, ranking math, or moderation
  must preserve compliance: no price-action language, return promises,
  or team-execution roadmaps (digital-collectible classification under
  the SEC/CFTC March 17 2026 release; FTC §5 / CFTC Rule 180.1 still
  reach deceptive marketing and manipulation).
- Don't add tracking, analytics, cookies, custody, or PII collection.
- Don't add team-roadmap or yield language anywhere.
- Don't add LLM-based moderation as a sole filter — deterministic
  rules are the floor.
- Mismatch between docs and code is a compliance smell. If you change
  the heat formula, update README.md, the in-page explainer, and
  CONTRIBUTING.md in the same PR.

## Questions?

Open an issue or find us on X [@PYREcoin](https://x.com/PYREcoin).
