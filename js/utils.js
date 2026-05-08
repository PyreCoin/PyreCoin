// Small DOM + formatting helpers shared across modules.

export const $ = id => document.getElementById(id);

export function fmt(n){
  if(n>=1000000) return (n/1000000).toFixed(2)+'M';
  if(n>=1000) return (n/1000).toFixed(1).replace(/\.0$/,'')+'K';
  return Math.round(n).toString();
}

export function hoursSince(iso, now){
  return Math.max(0, (now - new Date(iso)) / 3600000);
}

export function relTime(iso, now){
  const h = hoursSince(iso, now);
  if(h < 1) return Math.max(1, Math.round(h*60))+'m ago';
  if(h < 48) return Math.round(h)+'h ago';
  return Math.round(h/24)+'d ago';
}

export function shortAddr(s){return s.slice(0,4)+'…'+s.slice(-4);}

const _ESC = { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' };
export function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => _ESC[c]);
}

export function shortTx(s){
  if(!s) return '';
  if(s.length <= 14) return s; // already short or demo placeholder
  return s.slice(0,6)+'…'+s.slice(-4);
}

export function absTime(iso){
  const d = new Date(iso);
  const pad = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}
