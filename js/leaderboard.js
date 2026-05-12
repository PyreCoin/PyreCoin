// Leaderboard data + rendering — badge-bottom slot design.
//
// Each slot:
//   ┌──────────────────────────────────────────────────────────────┐
//   │  message text (or flavor quote for memo-less burns)          │
//   │                                                              │
//   │  🔥 1.2K $PYRE   ❤️‍🔥 4.7   ⏰ 2h ago   🌐 site   𝕏 @bob   👛 99j6…Pz8g │
//   └──────────────────────────────────────────────────────────────┘
//
// Top of slot — the message. Bottom row — small badges, every entry
// has the first three (burn / heat / time); url/x are optional and only
// render when present. Wallet shortcode is always shown; if an X handle
// is provided we show both.
//
// Heat per entry:
//   score = amount / (hours_since(ts) + 2)^GRAVITY
//
// Surfaces:
//   #lb-container → top-16 (the hero)
//   #bb-container → ranks 17+ (the backburner — same badge style, denser)

import { isPlaceholder } from './config.js';
import { fmt, hoursSince, relTime, utcTooltip, escapeHtml, shortAddr, hashString, safeHref, parseEmoji } from './utils.js';
import { getEntries } from './data.js';

const GRAVITY = 1.5;
const DECAY_BASE_HOURS = 2;
const TOP_N = 16;

function scoreEntry(entry, now){
  const h = hoursSince(entry.ts, now);
  return entry.amount / Math.pow(h + DECAY_BASE_HOURS, GRAVITY);
}

const FRESH_MULTIPLIER = Math.pow(DECAY_BASE_HOURS, GRAVITY);

// Min fresh-burn amount that would outrank the current #1 (read by
// burn.js to populate the modal helper).
export function minBurnToTakeTop(now){
  const entries = getEntries();
  if (entries.length === 0) return 1;
  const topScore = entries
    .map(e => scoreEntry(e, now))
    .reduce((m, s) => s > m ? s : m, 0);
  return Math.ceil(topScore * FRESH_MULTIPLIER) + 1;
}

export function liveEntryCount(){
  return getEntries().length;
}

// ── flavor quotes for memo-less burns ────────────────────────────
// Pure burns (no url, no msg, no x) deserve a slot too. We pick a quote
// deterministically from this pool by hashing the tx hash, so the same
// burn always renders the same quote across reloads — but the pool can
// evolve over time without rewriting leaderboard.json.
const FLAVOR_POOL = [
  'some people just want to watch $PYRE burn 🔥',
  'silent flame. loud chain. 🔥',
  'no words. just fire. 🔥',
  'a wordless tribute 🪔',
  'speaking with smoke signals 💨',
  'pure heat, no message 🔥',
  'shhh… listen to it crackle 🔥',
  'anonymous offering to the pyre 🪔',
  'all flame, no language 🔥',
  'sometimes the burn IS the message 🔥',
  'wordless, mintless, infinite 🔥',
  'sent without a sermon 🔥',
  'a burn without commentary 🔥',
  'the chain doesn’t need your reasons 🔥',
  'pure protocol. pure burn. 🔥',
  '🔥 🤫',
  'less talk. more fire. 🔥',
  'the pyre understands 🔥',
  '🔥 no notes 🔥',
  'no caption, no asterisk, just ash 🔥',
];

function flavorFor(tx){
  return FLAVOR_POOL[hashString(tx || '') % FLAVOR_POOL.length];
}

// Linkify URLs found in user message text (already HTML-escaped).
// Conservative TLD check avoids false-positives on "etc." / "e.g.".
// safeHref is the renderer-side defense-in-depth check: it rejects
// non-http(s) schemes, IP-literal hosts, and malformed URLs even
// though the ingest filter (scripts/lib/filter.mjs) is the
// authoritative gate. A single ingest regression shouldn't be enough
// to publish a javascript:/data: URL to live visitors.
const URL_RE = /(?:https?:\/\/[^\s<>"&]+)|(?:\b[a-z0-9](?:[\w\-]*[a-z0-9])?(?:\.[a-z0-9](?:[\w\-]*[a-z0-9])?){1,3}(?:\/[^\s<>"&]*)?)/gi;
function linkifyMsg(escaped){
  return escaped.replace(URL_RE, (m) => {
    const beforeSlash = m.split('/')[0];
    const lastDot = beforeSlash.lastIndexOf('.');
    if (lastDot < 0) return m;
    const tld = beforeSlash.slice(lastDot + 1);
    if (!/^[a-z]{2,8}$/i.test(tld)) return m;
    const href = safeHref(m);
    if (!href) return m;
    return `<a class="msg-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer ugc">${m}</a>`;
  });
}

// ── SVG icons ────────────────────────────────────────────────────
// X (Twitter) logo, monochrome. Sized via CSS.
const X_SVG = '<svg class="badge-x-icon" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>X</title><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg>';

// ── slot builders ────────────────────────────────────────────────

// Build the badge row that hangs at the bottom of every leaderboard
// slot. Returns an HTML string. Variant: 'hero' (top-16) or 'bb'
// (backburner, denser).
function badgeRow(entry, now, variant = 'hero'){
  const tx = encodeURIComponent(entry.tx || '');
  const amount = fmt(entry.amount || 0);
  const score = scoreEntry(entry, now);
  const heat = fmt(score);
  const rel = escapeHtml(relTime(entry.ts, now));
  const utc = escapeHtml(utcTooltip(entry.ts));
  const wallet = entry.wallet || '';
  const walletShort = shortAddr(wallet);
  const url = entry.url || '';
  const x = entry.x || '';

  const burnBadge = entry.tx ? `
    <a class="badge badge-burn" href="https://solscan.io/tx/${tx}" target="_blank" rel="noopener noreferrer"
       title="Verify burn on Solscan ↗">
      <span class="badge-icon">🔥</span><span class="badge-val">${escapeHtml(amount)}</span><span class="badge-unit">$PYRE</span>
    </a>` : '';

  const heatBadge = `
    <span class="badge badge-heat" title="Live heat — how this slot is ranked on the leaderboard. Formula: ($PYRE burned in this tx) ÷ (hours since the burn + 2)^1.5. So a big burn that's brand-new outranks a bigger burn from days ago; everything cools toward zero over time. Burn more, or burn fresher, to climb.">
      <span class="badge-icon">❤️‍🔥</span><span class="badge-val">${escapeHtml(heat)}</span>
    </span>`;

  const timeBadge = `
    <span class="badge badge-time" title="${utc}">
      <span class="badge-icon">⏰</span><span class="badge-val">${rel}</span>
    </span>`;

  const safeUrl = url ? safeHref(url) : null;
  const urlBadge = safeUrl ? `
    <a class="badge badge-url" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer sponsored ugc"
       title="${escapeHtml(url)}">
      <span class="badge-icon">🌐</span><span class="badge-val">${escapeHtml(url)}</span>
    </a>` : '';

  const xBadge = x ? `
    <a class="badge badge-x" href="https://x.com/${encodeURIComponent(x)}" target="_blank" rel="noopener noreferrer ugc"
       title="@${escapeHtml(x)} on X">
      ${X_SVG}<span class="badge-val">@${escapeHtml(x)}</span>
    </a>` : '';

  const walletBadge = wallet ? `
    <a class="badge badge-wallet" href="https://solscan.io/account/${encodeURIComponent(wallet)}" target="_blank" rel="noopener noreferrer"
       title="${escapeHtml(wallet)}">
      <span class="badge-icon">👛</span><span class="badge-val">${escapeHtml(walletShort)}</span>
    </a>` : '';

  return `<div class="badge-row badge-row-${variant}">${burnBadge}${heatBadge}${timeBadge}${urlBadge}${xBadge}${walletBadge}</div>`;
}

function buildSlot(entry, now){
  const div = document.createElement('div');
  div.className = 'slot';
  const hasMsg = !!(entry.msg && entry.msg.trim());
  const msgHtml = hasMsg
    ? `<div class="slot-msg">${linkifyMsg(escapeHtml(entry.msg))}</div>`
    : `<div class="slot-msg slot-msg-flavor" title="No message — flavor text for a pure burn">${escapeHtml(flavorFor(entry.tx))}</div>`;
  div.innerHTML = msgHtml + badgeRow(entry, now, 'hero');
  return div;
}

function buildBackburnerSlot(entry, rank, now){
  const div = document.createElement('div');
  div.className = 'bb-slot';
  const hasMsg = !!(entry.msg && entry.msg.trim());
  const msgHtml = hasMsg
    ? `<div class="bb-msg">${linkifyMsg(escapeHtml(entry.msg))}</div>`
    : `<div class="bb-msg bb-msg-flavor">${escapeHtml(flavorFor(entry.tx))}</div>`;
  div.innerHTML = `<div class="bb-rank">#${rank}</div>
    <div class="bb-body">${msgHtml}${badgeRow(entry, now, 'bb')}</div>`;
  return div;
}

const COLD_HTML = `
  <div class="lb-cold">
    <div class="lb-cold-title">The pyre is cold.</div>
    <div class="lb-cold-sub">Be the first to feed it. Any burn lights it up.</div>
  </div>`;

function renderBackburner(displaced, now){
  const section = document.getElementById('backburner');
  const host    = document.getElementById('bb-container');
  if (!section || !host) return;
  if (displaced.length === 0){
    section.style.display = 'none';
    host.innerHTML = '';
    return;
  }
  section.style.display = '';
  host.innerHTML = '';
  displaced.forEach((e, i) => {
    host.appendChild(buildBackburnerSlot(e, TOP_N + 1 + i, now));
  });
  parseEmoji(host);
}

export function renderLeaderboard(now){
  const lb = document.getElementById('lb-container');
  if (!lb) return;

  const preLaunch = isPlaceholder();
  const source = preLaunch ? [] : getEntries();

  const ranked = source
    .map(e => ({ entry: e, score: scoreEntry(e, now) }))
    .sort((a,b) => b.score - a.score)
    .map(r => r.entry);

  const top16     = ranked.slice(0, TOP_N);
  const displaced = ranked.slice(TOP_N);

  if (top16.length === 0){
    lb.innerHTML = COLD_HTML;
  } else {
    lb.innerHTML = '';
    top16.forEach(e => lb.appendChild(buildSlot(e, now)));
  }

  // Parse emoji to Twemoji SVGs so 🔥 ❤️‍🔥 ⏰ 🌐 👛 etc. render
  // identically across platforms. No-op if the CDN script is blocked
  // or hasn't loaded yet — native emoji is the graceful fallback.
  parseEmoji(lb);

  renderBackburner(displaced, now);
}
