// Deterministic moderation filter for ingested $PYRE burn memos.
//
// Pipeline (each step short-circuits on failure):
//   1. Normalize: NFKC + strip control / RTL / zero-width chars
//   2. Length caps
//   3. Hostname rules: HTTPS-only, no IP literals, no link shorteners,
//      no homograph abuse (mixed scripts in hostname)
//   4. Profanity (via `obscenity`, which handles leetspeak + confusables)
//
// Returns { ok: true, normalized: { url, msg } }
//      or { ok: false, reason: string }
//
// Rules are intentionally conservative. False positives go to pending.json
// and can be reviewed manually — but the live page only ever sees passes.

import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';

const URL_MAX = 200;
const MSG_MAX = 280;

const SHORTENER_HOSTS = new Set([
  'bit.ly', 't.co', 'tinyurl.com', 'ow.ly', 'is.gd', 'buff.ly', 'goo.gl',
  'rb.gy', 'cutt.ly', 'shorturl.at', 't.ly', 'lnk.bio', 'rebrand.ly',
]);

// Control chars (\x00-\x1F, \x7F), RTL/LRT overrides, zero-width chars,
// soft hyphens, and BOM.
const STRIPPED_CODEPOINTS = /[\x00-\x1F\x7F­​-‏‪-‮⁠-⁯﻿]/g;

const profanityMatcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

function normalize(s) {
  if (typeof s !== 'string') return '';
  return s.normalize('NFKC').replace(STRIPPED_CODEPOINTS, '').trim();
}

function isIpLiteral(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true; // IPv4
  if (host.startsWith('[') || host.includes(':')) return true; // IPv6 / port-shape abuse
  return false;
}

// Detect hostname mixing scripts in a way commonly used for homograph attacks.
// `new URL()` auto-Punycode-encodes non-ASCII hostnames, so we get the encoded
// form here. We reject:
//   - any non-[a-z0-9.-] character (defense-in-depth)
//   - any label starting with `xn--` (Punycode internationalized domain name)
// Strict-but-predictable for v0. Future versions can decode and accept
// single-script Unicode labels.
function looksLikeHomograph(host) {
  if (!/^[a-z0-9.\-]+$/.test(host)) return true;
  return host.split('.').some(label => label.startsWith('xn--'));
}

function checkUrl(input) {
  let urlStr = input;
  if (!/^https?:\/\//i.test(urlStr)) urlStr = 'https://' + urlStr;

  let parsed;
  try { parsed = new URL(urlStr); }
  catch { return { ok: false, reason: 'url_unparseable' }; }

  if (parsed.protocol !== 'https:') return { ok: false, reason: 'url_not_https' };

  const host = parsed.hostname.toLowerCase();
  if (!host.includes('.')) return { ok: false, reason: 'url_no_tld' };
  if (isIpLiteral(host)) return { ok: false, reason: 'url_ip_literal' };
  if (looksLikeHomograph(host)) return { ok: false, reason: 'url_non_ascii_host' };
  if (SHORTENER_HOSTS.has(host)) return { ok: false, reason: 'url_shortener' };

  // canonicalize: strip trailing slash on bare hosts; preserve everything else
  const canonical = parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname) +
                    parsed.search + parsed.hash;
  return { ok: true, canonical };
}

function checkProfanity(s) {
  return !profanityMatcher.hasMatch(s);
}

export function filterMemo({ url, msg }) {
  const u = normalize(url);
  const m = normalize(msg);

  if (!u) return { ok: false, reason: 'url_empty' };
  if (!m) return { ok: false, reason: 'msg_empty' };
  if (u.length > URL_MAX) return { ok: false, reason: 'url_too_long' };
  if (m.length > MSG_MAX) return { ok: false, reason: 'msg_too_long' };

  // The memo parser (scripts/lib/parse.mjs) splits on '|', so any
  // pipe in the URL would silently break parsing and the burn would
  // be quarantined with no leaderboard slot. Reject explicitly here
  // so the moderation log captures a clear reason.
  if (u.includes('|')) return { ok: false, reason: 'url_pipe' };
  if (m.includes('|')) return { ok: false, reason: 'msg_pipe' };

  const urlCheck = checkUrl(u);
  if (!urlCheck.ok) return urlCheck;

  if (!checkProfanity(m)) return { ok: false, reason: 'msg_profanity' };
  if (!checkProfanity(u)) return { ok: false, reason: 'url_profanity' };

  return { ok: true, normalized: { url: urlCheck.canonical, msg: m } };
}
