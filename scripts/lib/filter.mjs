// Deterministic moderation filter for ingested $PYRE memos.
//
// Inputs from parseMemo(): any subset of { url, x, msg }, all optional.
// A memo with no fields at all is rejected here (the ingest treats truly
// memoless burns separately — see solana.mjs / ingest.mjs); but a memo
// that parsed cleanly to an empty object never happens (parseMemo
// returns null in that case).
//
// Pipeline (each step short-circuits on failure):
//   1. Normalize each present field: NFKC + strip control/RTL/zero-width
//   2. Length caps on url/msg; format check on x handle
//   3. Pipe-character guard (the parser splits on `|`)
//   4. URL: HTTPS-only, no IP literals, no shorteners, no homograph abuse
//   5. Profanity scan (via `obscenity`, handles leetspeak + confusables)
//      on every present field
//
// Returns { ok: true, normalized: { url, x, msg } } where any field the
// memo omitted is the empty string.  Or { ok: false, reason: string }
// for the moderation log.

import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';

const URL_MAX = 200;
const MSG_MAX = 280;

// Twitter / X handle: alphanumeric + underscore, 1–15 chars. We strip
// the leading @ in parseMemo so we only see the bare handle here.
const X_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

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

  const canonical = parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname) +
                    parsed.search + parsed.hash;
  return { ok: true, canonical };
}

function checkProfanity(s) {
  return !profanityMatcher.hasMatch(s);
}

export function filterMemo(input = {}) {
  const u  = normalize(input.url || '');
  const m  = normalize(input.msg || '');
  const xh = normalize(input.x   || '');

  if (!u && !m && !xh) return { ok: false, reason: 'all_empty' };

  if (u.length  > URL_MAX) return { ok: false, reason: 'url_too_long' };
  if (m.length  > MSG_MAX) return { ok: false, reason: 'msg_too_long' };

  // The memo parser splits on '|', so any pipe in a field silently breaks
  // parsing. Reject explicitly here so the moderation log captures a
  // clear reason instead of an ambiguous parse failure.
  if (u.includes('|'))  return { ok: false, reason: 'url_pipe' };
  if (m.includes('|'))  return { ok: false, reason: 'msg_pipe' };
  if (xh.includes('|')) return { ok: false, reason: 'x_pipe' };

  if (xh && !X_HANDLE_RE.test(xh)) return { ok: false, reason: 'x_invalid' };

  let urlCanonical = '';
  if (u) {
    const urlCheck = checkUrl(u);
    if (!urlCheck.ok) return urlCheck;
    urlCanonical = urlCheck.canonical;
  }

  if (m  && !checkProfanity(m))  return { ok: false, reason: 'msg_profanity' };
  if (u  && !checkProfanity(u))  return { ok: false, reason: 'url_profanity' };
  if (xh && !checkProfanity(xh)) return { ok: false, reason: 'x_profanity' };

  return { ok: true, normalized: { url: urlCanonical, msg: m, x: xh } };
}
