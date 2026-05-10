// Leaderboard data + rendering.
//
// One unified list above the fold: 16 uniform rows, each
//   [ amount on the left ][ message in the middle ][ url on the right ]
// Same wallet can appear multiple times (per-burn entries).
// URLs found INSIDE message text are auto-linked.
//
// Score (per burn):
//     score = amount / (hours_since(ts) + 2)^GRAVITY
//
// Surfaces:
//   #lb-container → top-16 rows (the hero)
//   #bb-container → ranks 17+ (the backburner)

import { isPlaceholder } from './config.js';
import { fmt, hoursSince, relTime, escapeHtml } from './utils.js';

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
  const entries = _liveEntries || [];
  if (entries.length === 0) return 1;
  const topScore = entries
    .map(e => scoreEntry(e, now))
    .reduce((m, s) => s > m ? s : m, 0);
  return Math.ceil(topScore * FRESH_MULTIPLIER) + 1;
}

export function liveEntryCount(){
  return (_liveEntries || []).length;
}

// ── linkify ───────────────────────────────────────────────────────
// Turns URLs found inside message text into clickable anchors. Runs on
// already-HTML-escaped text — the regex excludes "&", ";", "<", ">",
// "\"" so existing HTML entities (&lt; &amp; etc.) aren't pulled into
// the match. Conservative TLD check (2-8 alpha chars) avoids
// false-positives on things like "etc." or "e.g.".
const URL_RE = /(?:https?:\/\/[^\s<>"&]+)|(?:\b[a-z0-9](?:[\w\-]*[a-z0-9])?(?:\.[a-z0-9](?:[\w\-]*[a-z0-9])?){1,3}(?:\/[^\s<>"&]*)?)/gi;

function linkifyMsg(escaped){
  return escaped.replace(URL_RE, (m) => {
    const beforeSlash = m.split('/')[0];
    const lastDot = beforeSlash.lastIndexOf('.');
    if (lastDot < 0) return m;
    const tld = beforeSlash.slice(lastDot + 1);
    if (!/^[a-z]{2,8}$/i.test(tld)) return m;
    const href = /^https?:\/\//i.test(m) ? m : 'https://' + m;
    return `<a class="msg-link" href="${href}" target="_blank" rel="noopener noreferrer ugc">${m}</a>`;
  });
}

// ── ember labels for backburner rows ─────────────────────────────
function emberLabel(hoursOld){
  if (hoursOld < 24)  return 'still warm';
  if (hoursOld < 72)  return 'smouldering';
  if (hoursOld < 168) return 'down to embers';
  return 'ash';
}

// ── TOP-16 ROWS (the hero) ───────────────────────────────────────
function buildSlot(entry, rank, now){
  const div = document.createElement('div');
  div.className = 'slot';
  const url = escapeHtml(entry.url);
  const msg = linkifyMsg(escapeHtml(entry.msg));
  const tx  = encodeURIComponent(entry.tx);
  // The burn amount itself IS the proof link — clicking it opens the
  // Solscan tx page for that specific burn. Title attribute provides
  // a hover hint explaining what the click does.
  div.innerHTML = `
    <a class="slot-amount" href="https://solscan.io/tx/${tx}" target="_blank" rel="noopener noreferrer" title="Verify this burn on Solscan ↗">${escapeHtml(fmt(entry.amount))}<span class="slot-ticker">$PYRE</span></a>
    <div class="slot-msg">${msg}</div>
    <a class="slot-url" href="https://${url}" target="_blank" rel="noopener noreferrer sponsored ugc">${url}<span class="slot-arrow"> ↗</span></a>`;
  return div;
}

const COLD_HTML = `
  <div class="lb-cold">
    <div class="lb-cold-title">The pyre is cold.</div>
    <div class="lb-cold-sub">Be the first to feed it. Any burn lights it up.</div>
  </div>`;

// ── BACKBURNER (ranks 17+) ──────────────────────────────────────
function buildBackburnerSlot(entry, rank, now){
  const div = document.createElement('div');
  div.className = 'bb-slot';
  const h   = hoursSince(entry.ts, now);
  const url = escapeHtml(entry.url);
  const msg = linkifyMsg(escapeHtml(entry.msg));
  const tx  = encodeURIComponent(entry.tx);
  div.innerHTML = `
    <div class="bb-rank">#${rank}</div>
    <div class="bb-body">
      <a class="bb-url" href="https://${url}" target="_blank" rel="noopener noreferrer sponsored ugc">${url}</a>
      <span class="bb-msg">${msg}</span>
    </div>
    <div class="bb-state">
      <span class="bb-ember">${emberLabel(h)}</span>
      <span class="bb-time">${escapeHtml(relTime(entry.ts, now))}</span>
      <a class="bb-solscan" href="https://solscan.io/tx/${tx}" target="_blank" rel="noopener noreferrer">↗</a>
    </div>
    <div class="bb-amount">${escapeHtml(fmt(entry.amount))} <span class="bb-ticker">$PYRE</span></div>`;
  return div;
}

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
}

// ── DATA ──────────────────────────────────────────────────────────
let _liveEntries = null;

async function loadLiveEntries(){
  try {
    const res = await fetch('./leaderboard.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    _liveEntries = (data && Array.isArray(data.entries)) ? data.entries : [];
  } catch (e) {
    _liveEntries = [];
  }
  renderLeaderboard(new Date());
}

loadLiveEntries();

export function renderLeaderboard(now){
  const lb = document.getElementById('lb-container');
  if (!lb) return;

  const preLaunch = isPlaceholder();
  const source = preLaunch ? [] : (_liveEntries || []);

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
    top16.forEach((e, i) => lb.appendChild(buildSlot(e, i + 1, now)));
  }

  renderBackburner(displaced, now);
}
