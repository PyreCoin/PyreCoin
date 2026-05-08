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
export const NOW_REF = new Date('2026-05-08T14:00:00Z'); // anchor for demo data

// Each entry: { wallet, url, msg, burns: [{amount, ts, tx}, ...] }
// Demo entries below are NEVER shown pre-launch (renderLeaderboard returns
// an empty state when isPlaceholder() is true). Once mainnet launches and
// ingest replaces this list with real burns, the renderer flips to the
// ranked-slot layout automatically.
export const ENTRIES = [
  // Old whales — big totals, but timestamps drag their score down
  {wallet:"7xKmP...f3Rq", url:"moonfi.xyz", msg:"Daily alpha calls. Real signals. No noise. Join 12,000 degens getting early calls every morning.", burns:[
    {amount:300000, ts:"2026-05-06T22:00:00Z", tx:"3nZ9x...8kLm"},
    {amount:120000, ts:"2026-05-07T18:00:00Z", tx:"3nZ9x...9aBc"}
  ]},
  {wallet:"4mRtQ...j2Wn", url:"degencasino.io", msg:"100x or bust. On-chain casino, provably fair, built on Solana.", burns:[
    {amount:311000, ts:"2026-05-08T09:00:00Z", tx:"8pLx2...4nKj"}
  ]},
  // Fresh medium burns — newer, can punch above their cumulative weight
  {wallet:"5fNwK...g7Mt", url:"solshield.xyz", msg:"On-chain rug detector. Free for the first 1,000 wallets. We pay you when we miss one.", burns:[
    {amount:88000, ts:"2026-05-08T13:30:00Z", tx:"2pNk9...mQ4r"}
  ]},
  {wallet:"9sNvR...k8Qp", url:"wagmi.club", msg:"Join the cult. 5,000 members. Weekly alpha. No paper hands allowed.", burns:[
    {amount:120000, ts:"2026-05-07T06:00:00Z", tx:"2mXq7...9pRn"},
    {amount:68500, ts:"2026-05-08T11:30:00Z", tx:"2mXq7...4dEp"}
  ]},
  // Cumulative grinder — many small, regular burns
  {wallet:"6rQmN...t4Lp", url:"solanaapes.io", msg:"10K collection. Floor moving. Don't sleep.", burns:[
    {amount:25000, ts:"2026-05-08T11:00:00Z", tx:"4kZm9...6nRq"},
    {amount:22500, ts:"2026-05-08T08:00:00Z", tx:"4kZm9...7sFp"},
    {amount:20000, ts:"2026-05-08T03:00:00Z", tx:"4kZm9...1tHn"}
  ]},
  {wallet:"2pLkM...r5Tn", url:"pump.fun/coin/xr9f4kzmq", msg:"New gem just dropped. Check the chart, not me.", burns:[
    {amount:92000, ts:"2026-05-08T03:00:00Z", tx:"7nQx4...2mPk"}
  ]},
  {wallet:"3tNpR...m7Kq", url:"defiwatch.xyz", msg:"Real-time DeFi analytics for Solana degens. Sane defaults. Sane alerts.", burns:[
    {amount:44200, ts:"2026-05-08T07:00:00Z", tx:"9pMx3...7kLn"}
  ]},
  {wallet:"8mKqL...n3Rp", url:"rugcheck.xyz", msg:"Check before you ape. Or after — at this point we don't judge.", burns:[
    {amount:31100, ts:"2026-05-08T10:00:00Z", tx:"5nZk8...3mQp"}
  ]},
  {wallet:"5nRtP...q9Mk", url:"soltracker.io", msg:"Track every whale move on Solana. Includes alerts for the whales who track you.", burns:[
    {amount:24800, ts:"2026-05-08T05:00:00Z", tx:"6mPn2...8kZq"}
  ]},
  {wallet:"1kMpQ...r6Nt", url:"burnboard.gg", msg:"The original burn leaderboard. Different chain, different vibe, same ash.", burns:[
    {amount:19600, ts:"2026-05-08T08:00:00Z", tx:"3nKm7...5pRx"}
  ]},
  {wallet:"7pNrK...m2Qt", url:"solmeme.fun", msg:"Meme launchpad on Solana. Zero fees. Negative dignity.", burns:[
    {amount:14300, ts:"2026-05-08T04:00:00Z", tx:"8kZn4...2mLp"}
  ]},
  {wallet:"4mQtN...p7Lr", url:"alphagroup.xyz", msg:"Private alpha. 100 seats left. Then 99. Then 100 again next week.", burns:[
    {amount:10900, ts:"2026-05-08T09:00:00Z", tx:"2pMk9...7nZr"}
  ]},
  // Tiny but extremely fresh — the "you'll only be here for an hour" slot
  {wallet:"9zMrW...d2Pk", url:"chainmail.gg", msg:"Inbox for your wallet. Project DMs you instead of you DMing them.", burns:[
    {amount:6800, ts:"2026-05-08T13:50:00Z", tx:"5pTr3...mN2q"}
  ]},
  {wallet:"9nLpM...k4Rt", url:"degen.tools", msg:"Every tool a degen needs. Plus three you don't.", burns:[
    {amount:8400, ts:"2026-05-08T06:00:00Z", tx:"7kNq3...4mPz"}
  ]},
  {wallet:"2rKmQ...t8Np", url:"pyreburn.xyz", msg:"🔥🔥🔥", burns:[
    {amount:6100, ts:"2026-05-08T11:00:00Z", tx:"5mZp8...9nRk"}
  ]},
  {wallet:"6pNtR...m3Kq", url:"solsignals.io", msg:"Free signals. Paid signals. You decide which lose more money.", burns:[
    {amount:4800, ts:"2026-05-08T07:00:00Z", tx:"4nMk6...3pZm"}
  ]},
  {wallet:"3mKqP...r9Nt", url:"mevblock.xyz", msg:"Stop getting sandwiched.", burns:[
    {amount:3200, ts:"2026-05-08T03:00:00Z", tx:"9pZn2...6mKr"}
  ]},
  {wallet:"8tNpM...q5Kr", url:"solport.io", msg:"Portfolio tracker. Free forever. Existential dread, not included.", burns:[
    {amount:2100, ts:"2026-05-08T12:00:00Z", tx:"3mZk7...8nPq"}
  ]}
];

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
          <span class="slot-tx-meta">heat ${escapeHtml(fmt(score))} · ${escapeHtml(fmt(total))} burned all-time · last fed ${escapeHtml(relTime(last, now))}</span>
          <span class="slot-verify-cta">verify ${burnCount} burn${burnCount === 1 ? '' : 's'} on solana</span>
        </summary>
        <ol class="burn-list">${burnRows}
      </ol>
      </details>
    </div>
    <div class="slot-burn">
      <span class="slot-amount">${escapeHtml(fmt(score))}</span>
      <span class="slot-ticker">${escapeHtml(fmt(total))} $PYRE burned</span>
    </div>`;
  return div;
}

export function renderLeaderboard(now){
  const lb = document.getElementById('lb-container');
  const preLaunch = isPlaceholder();

  // Keep the cadence badge honest: nothing to re-rank pre-launch.
  const badge = document.querySelector('#leaderboard .update-badge');
  if (badge) badge.innerHTML = preLaunch
    ? '<span class="update-dot"></span>Awaiting first burn'
    : '<span class="update-dot"></span>Re-ranks every 30s';

  // Pre-launch (placeholder mint) we render an empty state and never the
  // demo ENTRIES below — demo data must be clearly marked, and the
  // cleanest way to do that is to not display it at all.
  if (preLaunch) {
    lb.innerHTML = `
      <div style="text-align:center;padding:64px 24px;border:0.5px dashed var(--border);background:rgba(0,0,0,0.32);">
        <div style="font-size:44px;line-height:1;margin-bottom:14px;opacity:0.45;filter:saturate(0.7);">🔥</div>
        <div style="font-family:'DM Mono',monospace;font-size:13px;color:var(--text);letter-spacing:0.06em;text-transform:uppercase;margin-bottom:10px;">Awaiting first burn</div>
        <div style="font-family:'DM Mono',monospace;font-size:12px;color:var(--text2);max-width:440px;margin:0 auto;line-height:1.65;">The pyre is cold. Be the first to feed it — your URL takes the top slot until someone outburns you.</div>
      </div>`;
    return;
  }

  const ranked = ENTRIES
    .map(e => ({entry:e, score:scoreEntry(e, now)}))
    .sort((a,b)=> b.score - a.score)
    .slice(0, 16);
  lb.innerHTML = '';
  ranked.forEach((r, i) => lb.appendChild(buildSlot(r.entry, i+1, now)));
}
