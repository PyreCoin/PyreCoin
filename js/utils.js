// Small DOM + formatting helpers shared across modules.

export const $ = id => document.getElementById(id);

export function fmt(n){
  if(n>=1000000) return (n/1000000).toFixed(2)+'M';
  if(n>=1000) return (n/1000).toFixed(1).replace(/\.0$/,'')+'K';
  if(n>=1) return Math.round(n).toString();
  return n.toFixed(3).replace(/\.?0+$/,'') || '0';
}

export function hoursSince(iso, now){
  return Math.max(0, (now - new Date(iso)) / 3600000);
}

// Relative time string with finer-grained early buckets so a fresh
// burn doesn't read "1m ago" for the first 60 seconds.
export function relTime(iso, now){
  const h = hoursSince(iso, now);
  const m = h * 60;
  if(m < 1)   return 'just now';
  if(m < 60)  return Math.round(m)+'m ago';
  if(h < 48)  return Math.round(h)+'h ago';
  const d = h/24;
  if(d < 60)  return Math.round(d)+'d ago';
  if(d < 730) return Math.round(d/30)+'mo ago';
  return Math.round(d/365)+'y ago';
}

// Precise UTC timestamp for tooltips — readable, unambiguous.
export function utcTooltip(iso){
  const d = new Date(iso);
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export function shortAddr(s){
  if (!s) return '';
  return s.slice(0,4)+'…'+s.slice(-4);
}

const _ESC = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
export function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => _ESC[c]);
}

// Stable non-cryptographic hash of a string → 32-bit unsigned int.
// Used to deterministically pick a flavor-text quote for memo-less
// burns: same tx hash always picks the same quote across reloads,
// without storing the quote in leaderboard.json (lets the pool evolve).
export function hashString(s){
  let h = 2166136261 >>> 0; // FNV-1a 32-bit
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

// ── money / token formatting ─────────────────────────────────────
// Single source of truth — used by main.js (CTA), buy.js, burn.js
// (bill of sale). Variants below; pick by call site.

// Compact USD string. Buckets keep tiny memecoin prices readable
// (sub-cent gets more decimals) while large totals stay scannable.
export function fmtUsd(usd){
  if (!Number.isFinite(usd) || usd <= 0) return '$—';
  if (usd >= 1000) return '$' + Math.round(usd).toLocaleString();
  if (usd >= 1)    return '$' + usd.toFixed(2);
  if (usd >= 0.01) return '$' + usd.toFixed(3);
  if (usd >= 0.0001) return '$' + usd.toFixed(5);
  return '$' + usd.toFixed(7);
}

// Same buckets as fmtUsd, but prefixed "~" — used in the bill of sale
// where every line is an estimate (network fees, swap prices drift).
export function fmtUsdApprox(usd){
  if (!isFinite(usd) || usd <= 0) return '~$0';
  if (usd >= 1000) return '~$' + Math.round(usd).toLocaleString();
  if (usd >= 1)    return '~$' + usd.toFixed(2);
  if (usd >= 0.01) return '~$' + usd.toFixed(3);
  if (usd >= 0.0001) return '~$' + usd.toFixed(5);
  return '~$' + usd.toFixed(7);
}

// Trim trailing zeros + a stranded decimal point from a fixed-decimal
// numeric string. "1.20000" → "1.2"; "1.00000" → "1"; "1." → "1".
export function trimDecimals(s){
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

// Numeric amount → display string with up to maxDp decimals, trimmed.
export function fmtAmount(n, maxDp = 6){
  if (!Number.isFinite(n) || n <= 0) return '0';
  return trimDecimals(n.toFixed(maxDp));
}

// Scale a UI amount to raw base units via integer math to avoid
// 0.1+0.2 floating-point drift on the fractional component. Returns
// BigInt of the raw amount. Single source of truth used by every
// module that crafts a token instruction.
export function scaleToRaw(uiAmount, decimals){
  const s = uiAmount.toFixed(decimals);
  const [whole, frac = ''] = s.split('.');
  const padded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || '0');
}

// ── country code helpers ────────────────────────────────────────
// Turn an ISO 3166-1 alpha-2 country code ("US", "GB", "DE") into:
//   - the Unicode flag emoji ("🇺🇸", "🇬🇧", "🇩🇪") via the regional-
//     indicator letter pairing (U+1F1E6..U+1F1FF). Twemoji's parser
//     swaps these to consistent SVG glyphs cross-platform.
//   - the human-readable country name ("United States", "United
//     Kingdom", "Germany") via Intl.DisplayNames, the standard
//     browser-bundled localization API. Falls back to the raw code
//     if DisplayNames isn't available or the code is unrecognized.

function _looksIsoCode(s){
  return typeof s === 'string' && /^[A-Za-z]{2}$/.test(s);
}

export function isoToFlag(code){
  if (!_looksIsoCode(code)) return '';
  const up = code.toUpperCase();
  const A = 0x1F1E6;
  return String.fromCodePoint(
    A + up.charCodeAt(0) - 65,
    A + up.charCodeAt(1) - 65,
  );
}

let _regionDn = null;
function _getRegionDn(){
  if (_regionDn !== null) return _regionDn;
  try {
    _regionDn = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch { _regionDn = false; }
  return _regionDn;
}
export function isoToName(code){
  if (!_looksIsoCode(code)) return code || '';
  const dn = _getRegionDn();
  if (!dn) return code.toUpperCase();
  try { return dn.of(code.toUpperCase()) || code.toUpperCase(); }
  catch { return code.toUpperCase(); }
}

// Twemoji parser shim. The @twemoji/api CDN bundle exposes
// window.twemoji; renderers call parseEmoji(node) after dropping new
// HTML into the DOM so emoji characters get swapped to consistent SVG
// images. No-op when the script hasn't loaded yet (or has been blocked
// by an extension) so the page degrades gracefully to native emoji.
//
// Folder + ext: SVG variant for crisp scaling; the className lets us
// style every parsed img with one CSS rule (vertical-align + height).
export function parseEmoji(node) {
  if (!node) return;
  const tw = (typeof window !== 'undefined') ? window.twemoji : null;
  if (!tw || typeof tw.parse !== 'function') return;
  try {
    tw.parse(node, { folder: 'svg', ext: '.svg', className: 'twemoji' });
  } catch (_) { /* defensive: parsing some Unicode sequences can throw */ }
}

// Defense-in-depth href validator for user-content URLs (leaderboard
// + inscription wall renderers). The ingest filter is authoritative
// but renderer-side checking means a single ingest regression can't
// publish dangerous href values to live visitors.
//
// Accept rules: must be a parseable URL (after prepending https:// if
// the bare-domain form is passed), https only, hostname must contain
// a dot, no IP-literal hostnames. Returns the canonicalized href on
// success, or null to signal "render as plain text, not a link."
export function safeHref(url){
  if (typeof url !== 'string') return null;
  const raw = url.trim();
  if (!raw) return null;
  // Reject schemes other than http/https outright. We prepend https://
  // below for bare domains, but any explicit scheme stays as-is for the
  // protocol check.
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^https?:\/\//i.test(raw)) return null;
  const candidate = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;
  let u;
  try { u = new URL(candidate); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!u.hostname || !u.hostname.includes('.')) return null;
  // No IP-literal hostnames (per moderation policy).
  if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return null;
  if (/^\[.*\]$/.test(u.hostname)) return null; // IPv6 bracket form
  // Force https on the final href — we only ever publish https URLs.
  u.protocol = 'https:';
  return u.toString();
}
