// Leaderboard data + rendering. Score is computed via time-decay
// (HN/Reddit-style "hot" ranking), so old whales fade and fresh burns can
// climb. Feed the pyre to stay on top — that's the whole game.
//
// Score formula:
//     score(wallet) = Σ ( amount_i / (hours_since(ts_i) + 2)^GRAVITY )
//
// GRAVITY tuning:
//     1.5 → top burn meaningfully fades over ~24h, stale by ~72h.
//     Higher = faster churn. Lower = whales sticky for days.

import { isPlaceholder } from './config.js';
import { fmt, hoursSince, relTime, absTime, shortTx, escapeHtml } from './utils.js';

const GRAVITY = 1.5;
const DECAY_BASE_HOURS = 2;

// Each live entry: { wallet, url, msg, burns: [{amount, ts, tx}, ...] }
// — same shape the ingest pipeline writes to leaderboard.json.

function scoreEntry(entry, now){
  let s = 0;
  for(const b of entry.burns){
    const h = hoursSince(b.ts, now);
    s += b.amount / Math.pow(h + DECAY_BASE_HOURS, GRAVITY);
  }
  return s;
}

export function totalBurned(entry){
  return entry.burns.reduce((a,b)=>a+b.amount, 0);
}

function latestBurn(entry){
  return entry.burns.reduce((max,b)=> b.ts > max ? b.ts : max, '0');
}

function buildSlot(entry, rank, now){
  const div = document.createElement('div');
  div.className = 'slot rank'+rank;
  const score = scoreEntry(entry, now);
  const total = totalBurned(entry);
  const last = latestBurn(entry);
  const burnCount = entry.burns.length;
  const burnsByRecency = [...entry.burns].sort((a,b)=> b.ts.localeCompare(a.ts));
  // All user-controlled fields (entry.url, entry.msg, every b.*) come from
  // on-chain memos that the moderation filter has structurally validated
  // but does NOT HTML-escape. We MUST escape before feeding into innerHTML
  // — the URL canonicalization preserves path/query/hash which can carry
  // <script> bytes through any number of structural checks.
  const url = escapeHtml(entry.url);
  const msg = escapeHtml(entry.msg);
  const burnRows = burnsByRecency.map(b => `
        <li class="burn-item">
          <span class="burn-amount">${escapeHtml(fmt(b.amount))} $PYRE</span>
          <span class="burn-time">${escapeHtml(absTime(b.ts))}</span>
          <a class="burn-tx-link" href="https://solscan.io/tx/${encodeURIComponent(b.tx)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortTx(b.tx))} ↗</a>
        </li>`).join('');
  div.innerHTML = `
    <div class="slot-rank">${rank}</div>
    <div class="slot-body">
      <a class="slot-url" href="https://${url}" target="_blank" rel="noopener noreferrer sponsored ugc">${url}</a>
      <span class="slot-msg">${msg}</span>
      <details class="slot-verify">
        <summary class="slot-verify-summary">
          <span class="slot-tx-meta">last fed ${escapeHtml(relTime(last, now))}</span>
          <span class="slot-verify-cta">verify on solana</span>
        </summary>
        <ol class="burn-list">${burnRows}
      </ol>
      </details>
    </div>
    <div class="slot-burn">
      <span class="slot-amount">${escapeHtml(fmt(total))}</span>
      <span class="slot-ticker">$PYRE burned</span>
    </div>`;
  return div;
}

// Live leaderboard entries fetched from leaderboard.json. The ingest
// pipeline (scripts/ingest.mjs, run by GitHub Actions every 5 min)
// writes accepted on-chain burns into that file. We fetch it on
// module load and re-render once it resolves.
let _liveEntries = null;

async function loadLiveEntries(){
  try {
    const res = await fetch('./leaderboard.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    _liveEntries = (data && Array.isArray(data.entries)) ? data.entries : [];
  } catch (e) {
    // Network/parse error — render the empty state instead of crashing
    // or surfacing demo data. The page is still useful (footer, rules,
    // disclaimer); just no leaderboard until the next reload.
    _liveEntries = [];
  }
  // Refresh now that data has arrived. The first paint already showed
  // an empty state; this swap is what makes new burns appear.
  renderLeaderboard(new Date());
}

// Kick off the fetch immediately on module import.
loadLiveEntries();

const EMPTY_STATE_HTML = `
      <div style="text-align:center;padding:64px 24px;border:0.5px dashed var(--border);background:rgba(0,0,0,0.32);">
        <div style="font-size:44px;line-height:1;margin-bottom:14px;opacity:0.45;filter:saturate(0.7);">🔥</div>
        <div style="font-family:'DM Mono',monospace;font-size:13px;color:var(--text);letter-spacing:0.06em;text-transform:uppercase;margin-bottom:10px;">Awaiting first burn</div>
        <div style="font-family:'DM Mono',monospace;font-size:12px;color:var(--text2);max-width:440px;margin:0 auto;line-height:1.65;">The pyre is cold. Be the first to feed it — your URL takes the top slot until someone outburns you.</div>
      </div>`;

export function renderLeaderboard(now){
  const lb = document.getElementById('lb-container');
  const preLaunch = isPlaceholder();

  // Pre-launch always shows the empty state. Post-launch, the empty
  // state is rendered while the JSON fetch is still pending, and also
  // when the JSON has zero entries (e.g., immediately after the
  // mainnet flip wipes leaderboard.json).
  const source = preLaunch ? [] : (_liveEntries || []);
  if (source.length === 0) {
    lb.innerHTML = EMPTY_STATE_HTML;
    return;
  }

  const ranked = source
    .map(e => ({entry:e, score:scoreEntry(e, now)}))
    .sort((a,b)=> b.score - a.score)
    .slice(0, 16);
  lb.innerHTML = '';
  ranked.forEach((r, i) => lb.appendChild(buildSlot(r.entry, i+1, now)));
}
