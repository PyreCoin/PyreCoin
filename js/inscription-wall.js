// Inscription Wall — chronological feed of memo-only inscriptions
// (no $PYRE burned, just SOL fees + Memo Program payload).
//
// Same badge style as the leaderboard but minus 🔥 amount and ❤️‍🔥 heat
// (an inscription doesn't burn PYRE, so neither makes sense). Wallet,
// time, optional url, optional X handle, and an inscription-proof
// Solscan badge ⛓️ at the front. Newest-first; capped at WALL_CAP entries.

import { relTime, utcTooltip, escapeHtml, shortAddr } from './utils.js';
import { getInscriptions } from './data.js';

const WALL_CAP = 50;

const X_SVG = '<svg class="badge-x-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';

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

  const urlBadge = url ? `
    <a class="badge badge-url" href="https://${escapeHtml(url)}" target="_blank" rel="noopener noreferrer sponsored ugc"
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
}
