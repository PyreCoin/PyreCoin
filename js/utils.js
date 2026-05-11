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
