// Inscription Wall — chronological feed of memo-only inscriptions
// (no $PYRE burned, just SOL fees + Memo Program payload).
//
// Same badge style as the leaderboard but minus 🔥 amount and ❤️‍🔥 heat
// (an inscription doesn't burn PYRE, so neither makes sense). Wallet,
// time, optional url, optional X handle, and an inscription-proof
// Solscan badge ⛓️ at the front. Newest-first; capped at WALL_CAP entries.

import { relTime, utcTooltip, escapeHtml, shortAddr, safeHref, parseEmoji } from './utils.js';
import { getInscriptions } from './data.js';

const WALL_CAP = 50;

const X_SVG = '<svg class="badge-x-icon" role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><title>X</title><path d="M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z"/></svg>';

function badgeRow(entry, now){
  const tx = encodeURIComponent(entry.tx || '');
  const rel = escapeHtml(relTime(entry.ts, now));
  const utc = escapeHtml(utcTooltip(entry.ts));
  const wallet = entry.wallet || '';
  const walletShort = shortAddr(wallet);
  const url = entry.url || '';
  const x = entry.x || '';

  const proofBadge = entry.tx ? `
    <a class="badge badge-proof" href="https://solscan.io/tx/${tx}" target="_blank" rel="noopener noreferrer"
       title="Inscription proof on Solscan ↗">
      <span class="badge-icon">⛓️</span><span class="badge-val">on-chain</span>
    </a>` : '';

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

  return `<div class="badge-row badge-row-wall">${proofBadge}${timeBadge}${urlBadge}${xBadge}${walletBadge}</div>`;
}

function buildWallSlot(entry, now){
  const div = document.createElement('div');
  div.className = 'wall-slot';
  const msg = entry.msg && entry.msg.trim()
    ? `<div class="wall-msg">${escapeHtml(entry.msg)}</div>`
    : '';
  div.innerHTML = msg + badgeRow(entry, now);
  return div;
}

const EMPTY_HTML = `
  <div class="wall-empty">
    <div class="wall-empty-title">The wall is bare.</div>
    <div class="wall-empty-sub">Inscribe yours for a fraction of a cent in SOL.</div>
  </div>`;

export function renderInscriptionWall(now){
  const host = document.getElementById('wall-container');
  if (!host) return;

  const entries = getInscriptions().slice(0, WALL_CAP);

  if (entries.length === 0){
    host.innerHTML = EMPTY_HTML;
    return;
  }

  host.innerHTML = '';
  entries.forEach(e => host.appendChild(buildWallSlot(e, now)));
  parseEmoji(host);
}
