// Pure inline-SVG chart primitives — zero dependencies, ember-styled.
//
// Used by:
//   - js/stats.js    (sparklines under each stat card)
//   - js/big-charts.js (the four panels under "By the Numbers")
//
// Why hand-rolled SVG and not a chart library:
//   - This page is committed to "no build step, no bundler" (see
//     index.html bottom + CLAUDE.md §7.1). Adding a CDN chart lib
//     means another network dep and another moving piece in the
//     cache-bust dance.
//   - These charts are visually owned by the brand (ember stroke,
//     dark glass panels, the no-axes minimalism elsewhere on the
//     page). Hand-rolled SVG matches it exactly without override
//     wars against a library's defaults.
//   - 240 hourly candles + 240 hourly bars is well within what
//     in-DOM SVG can render at 60fps on a phone. We're nowhere near
//     the volume that would require Canvas.
//
// All renderers take a container element + a values/buckets/ohlcv
// array + opts, and replace the container's innerHTML. They never
// throw; bad input renders an empty-state placeholder so a single
// flaky data source never tanks the section.

const COLOR = {
  emberStroke: '#ff6622',
  emberFill:   '#ff6622',
  emberSoft:   '#ffaa33',
  up:          '#5dd99a',  // matches .stat-change.up
  down:        '#ff7a7a',  // matches .stat-change.down
  axis:        'rgba(255,140,60,0.12)',
  text:        'rgba(255,180,100,0.45)',
};

// ── helpers ──────────────────────────────────────────────────────

function escapeAttr(s){
  return String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
}

function emptyState(container, msg){
  if (!container) return;
  container.innerHTML = `<div class="chart-panel-empty">${escapeAttr(msg)}</div>`;
}

// Stable unique id per renderer call so multiple gradient defs on
// the same page don't collide. Crypto.randomUUID is everywhere now;
// fall back for very old browsers but they aren't a concern.
let _gradSeq = 0;
function uid(prefix){
  _gradSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${_gradSeq}`;
}

// ── sparkline ────────────────────────────────────────────────────
// Tiny line + area-fill chart. Used inside each stat card.
// values: array of numbers (NaN/null entries are bridged by linear
// interpolation across them; if everything is null, render empty).
// opts.tone: 'up' | 'down' | 'neutral' (default = ember)
// opts.dot:  true to draw a final-point dot (default true)

export function sparkline(container, values, opts = {}){
  if (!container) return;
  if (!Array.isArray(values) || values.length === 0) {
    container.innerHTML = '';
    return;
  }
  const tone = opts.tone || 'neutral';
  const dot  = opts.dot !== false;

  const clean = values.map(v => (typeof v === 'number' && isFinite(v)) ? v : null);
  const present = clean.filter(v => v != null);
  if (present.length === 0) { container.innerHTML = ''; return; }

  const minV = Math.min(...present);
  const maxV = Math.max(...present);
  const range = (maxV - minV) || 1;

  // Drawing canvas in viewBox units. preserveAspectRatio="none" lets
  // the path stretch to whatever the CSS-sized container is — the
  // visual is linear-line, not a circle, so distortion is fine.
  const W = 100, H = 30, P = 1;

  // Build a single path command string. Bridge null gaps by repeating
  // the previous y, so the line stays continuous (better than visual
  // gaps for sparklines, which are too small to read pause-states).
  const n = clean.length;
  let lastY = null;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const x = (n === 1) ? W/2 : P + (i / (n - 1)) * (W - 2*P);
    let y;
    if (clean[i] != null) {
      y = (H - P) - ((clean[i] - minV) / range) * (H - 2*P);
      lastY = y;
    } else if (lastY != null) {
      y = lastY;
    } else {
      continue;
    }
    pts.push([x, y]);
  }
  if (pts.length === 0) { container.innerHTML = ''; return; }

  const lineD = pts.map((p, i) => (i === 0 ? `M${p[0].toFixed(2)},${p[1].toFixed(2)}` : `L${p[0].toFixed(2)},${p[1].toFixed(2)}`)).join(' ');
  const areaD = `${lineD} L${pts[pts.length-1][0].toFixed(2)},${H} L${pts[0][0].toFixed(2)},${H} Z`;

  const stroke = tone === 'up' ? COLOR.up
              : tone === 'down' ? COLOR.down
              : COLOR.emberStroke;
  const fillStop = tone === 'up' ? COLOR.up
                : tone === 'down' ? COLOR.down
                : COLOR.emberFill;

  const gid = uid('spark-grad');
  const last = pts[pts.length - 1];

  container.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${fillStop}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${fillStop}" stop-opacity="0"/>
    </linearGradient>
  </defs>
  <path d="${areaD}" fill="url(#${gid})" stroke="none"/>
  <path d="${lineD}" fill="none" stroke="${stroke}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  ${dot ? `<circle cx="${last[0].toFixed(2)}" cy="${last[1].toFixed(2)}" r="1.6" fill="${stroke}" stroke="rgba(0,0,0,0.4)" stroke-width="0.5" vector-effect="non-scaling-stroke"/>` : ''}
</svg>`;
}

// ── histogram (vertical bars) ────────────────────────────────────
// buckets: array of numbers (one per time slot, oldest → newest)
// opts.height (default 240)
// opts.formatTooltip: (idx, value) => string (rendered as <title>)

export function histogramBars(container, buckets, opts = {}){
  if (!container) { return; }
  if (!Array.isArray(buckets) || buckets.length === 0) {
    emptyState(container, 'no data yet · check back soon');
    return;
  }
  const height = opts.height || 240;
  const tipFn  = opts.formatTooltip || ((i, v) => `bucket ${i}: ${v}`);

  const vals = buckets.map(v => (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 0);
  const max = Math.max(...vals, 0);
  if (max <= 0) {
    emptyState(container, 'no activity in this window');
    return;
  }

  const n = vals.length;
  const W = Math.max(400, n * 4); // enough resolution; SVG scales to container
  const H = height;
  const TOP_PAD = 8, BOT_PAD = 14, SIDE_PAD = 4;
  const innerH = H - TOP_PAD - BOT_PAD;
  const slotW = (W - 2*SIDE_PAD) / n;
  const barW = Math.max(1, slotW * 0.78);

  // Reference grid (4 horizontal lines + dim labels). Labels show the
  // raw bucket values, formatted by opts.formatY if supplied.
  const fmtY = opts.formatY || (v => Math.round(v).toLocaleString());
  const grids = [];
  const lines = 4;
  for (let i = 0; i <= lines; i++) {
    const v = (max * (lines - i)) / lines;
    const y = TOP_PAD + (i / lines) * innerH;
    grids.push(`<line x1="0" x2="${W}" y1="${y}" y2="${y}" stroke="${COLOR.axis}" stroke-width="0.5" stroke-dasharray="2,3"/>`);
    grids.push(`<text x="6" y="${y - 2}" font-family="DM Mono, monospace" font-size="9" fill="${COLOR.text}" text-anchor="start">${escapeAttr(fmtY(v))}</text>`);
  }

  const gid = uid('hist-grad');
  const bars = vals.map((v, i) => {
    if (v <= 0) return '';
    const h = (v / max) * innerH;
    const x = SIDE_PAD + i * slotW + (slotW - barW) / 2;
    const y = TOP_PAD + (innerH - h);
    return `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${h.toFixed(2)}" fill="url(#${gid})" rx="0.5"><title>${escapeAttr(tipFn(i, v))}</title></rect>`;
  }).join('');

  container.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="false" role="img">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${COLOR.emberSoft}" stop-opacity="0.95"/>
      <stop offset="100%" stop-color="${COLOR.emberFill}" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  ${grids.join('')}
  ${bars}
</svg>`;
}

// ── candlestick chart ────────────────────────────────────────────
// ohlcv: array of [tsSeconds, open, high, low, close, volume]
//        (matches GeckoTerminal /ohlcv response shape).
// opts.height (default 240)

export function candlestick(container, ohlcv, opts = {}){
  if (!container) return;
  if (!Array.isArray(ohlcv) || ohlcv.length === 0) {
    emptyState(container, 'no price candles yet · check back soon');
    return;
  }
  const height = opts.height || 240;

  // Filter out malformed rows. GT returns numbers consistently but be
  // defensive — one bad row would NaN-poison min/max.
  const rows = ohlcv.filter(r => Array.isArray(r) && r.length >= 5
    && r.slice(1, 5).every(x => typeof x === 'number' && isFinite(x))
  );
  if (rows.length === 0) { emptyState(container, 'no valid price data'); return; }

  // Min/max across all wick prices, with a tiny pad so candles never
  // touch the chart edge.
  let lo = Infinity, hi = -Infinity;
  for (const r of rows) {
    if (r[3] < lo) lo = r[3];
    if (r[2] > hi) hi = r[2];
  }
  const pad = (hi - lo) * 0.06 || hi * 0.06 || 1;
  lo -= pad; hi += pad;
  const range = (hi - lo) || 1;

  const n = rows.length;
  const W = Math.max(400, n * 4);
  const H = height;
  const TOP_PAD = 8, BOT_PAD = 14, LEFT_PAD = 4, RIGHT_PAD = 50;
  const innerH = H - TOP_PAD - BOT_PAD;
  const innerW = W - LEFT_PAD - RIGHT_PAD;
  const slotW = innerW / n;
  const bodyW = Math.max(1, slotW * 0.7);
  const wickW = Math.max(0.5, Math.min(1.5, slotW * 0.15));

  const yFor = p => TOP_PAD + (innerH - ((p - lo) / range) * innerH);

  const fmtPrice = (p) => {
    if (!isFinite(p)) return '—';
    if (p < 1e-6) return p.toExponential(2);
    if (p < 0.0001) return p.toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
    if (p < 1)      return p.toFixed(6);
    return p.toFixed(4);
  };

  // Grid + price labels on the right edge.
  const gridLines = 4;
  const grids = [];
  for (let i = 0; i <= gridLines; i++) {
    const p = lo + range * (gridLines - i) / gridLines;
    const y = TOP_PAD + (i / gridLines) * innerH;
    grids.push(`<line x1="${LEFT_PAD}" x2="${LEFT_PAD + innerW}" y1="${y}" y2="${y}" stroke="${COLOR.axis}" stroke-width="0.5" stroke-dasharray="2,3"/>`);
    grids.push(`<text x="${LEFT_PAD + innerW + 4}" y="${y + 3}" font-family="DM Mono, monospace" font-size="9" fill="${COLOR.text}" text-anchor="start">$${escapeAttr(fmtPrice(p))}</text>`);
  }

  const candles = rows.map((r, i) => {
    const [ts, o, h, l, c] = r;
    const up = c >= o;
    const color = up ? COLOR.up : COLOR.down;
    const x = LEFT_PAD + i * slotW + slotW / 2;
    const yHi = yFor(h);
    const yLo = yFor(l);
    const yO  = yFor(o);
    const yC  = yFor(c);
    const yT  = Math.min(yO, yC);
    const yB  = Math.max(yO, yC);
    const bx  = x - bodyW / 2;
    const tipDate = new Date(ts * 1000).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
    const tip = `${tipDate}\nO ${fmtPrice(o)}  H ${fmtPrice(h)}\nL ${fmtPrice(l)}  C ${fmtPrice(c)}`;
    return `<g>
      <rect x="${(x - wickW/2).toFixed(2)}" y="${yHi.toFixed(2)}" width="${wickW.toFixed(2)}" height="${(yLo - yHi).toFixed(2)}" fill="${color}"/>
      <rect x="${bx.toFixed(2)}" y="${yT.toFixed(2)}" width="${bodyW.toFixed(2)}" height="${Math.max(0.6, yB - yT).toFixed(2)}" fill="${color}" fill-opacity="${up ? 0.85 : 0.85}" stroke="${color}" stroke-width="0.4"/>
      <title>${escapeAttr(tip)}</title>
    </g>`;
  }).join('');

  container.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="false" role="img">
  ${grids.join('')}
  ${candles}
</svg>`;
}

// ── horizontal bar chart (used for "Top countries") ──────────────
// items: [{label, value}, ...] (already sorted desc; renderer takes
// them as-is and trims to opts.limit).

export function horizontalBars(container, items, opts = {}){
  if (!container) return;
  if (!Array.isArray(items) || items.length === 0) {
    emptyState(container, 'no visitor data yet · check back once the beacon has data');
    return;
  }
  const limit = opts.limit || 10;
  const trimmed = items.slice(0, limit).filter(it => it && typeof it.value === 'number' && it.value > 0);
  if (trimmed.length === 0) { emptyState(container, 'no visitor data yet'); return; }
  const max = Math.max(...trimmed.map(it => it.value));
  const total = trimmed.reduce((s, it) => s + it.value, 0);

  // SVG-rendered horizontal bars with country label + percentage.
  // Row height fixed; the panel height in CSS will scroll if too
  // many rows. With limit 10, all fit comfortably in the 240px panel.
  const ROW_H = 22, GAP = 4;
  const n = trimmed.length;
  const H = n * (ROW_H + GAP) - GAP;
  const W = 600;
  const LABEL_W = 130, PCT_W = 60, PAD = 8;
  const BAR_X = LABEL_W + PAD;
  const BAR_W_MAX = W - BAR_X - PCT_W - PAD;

  const gid = uid('hbar-grad');
  const rows = trimmed.map((it, i) => {
    const y = i * (ROW_H + GAP);
    const w = (it.value / max) * BAR_W_MAX;
    const pct = total > 0 ? (it.value / total * 100) : 0;
    const pctTxt = pct >= 10 ? pct.toFixed(0) + '%' : pct.toFixed(1) + '%';
    return `<g>
      <text x="0" y="${y + ROW_H/2 + 4}" font-family="DM Mono, monospace" font-size="11" fill="rgba(255,220,170,0.85)" text-anchor="start">${escapeAttr(it.label)}</text>
      <rect x="${BAR_X}" y="${y + 3}" width="${w.toFixed(2)}" height="${ROW_H - 6}" fill="url(#${gid})" rx="1"/>
      <text x="${W - PAD}" y="${y + ROW_H/2 + 4}" font-family="DM Mono, monospace" font-size="11" fill="${COLOR.emberSoft}" text-anchor="end">${escapeAttr(pctTxt)}</text>
    </g>`;
  }).join('');

  container.innerHTML = `
<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMin meet" aria-hidden="false" role="img">
  <defs>
    <linearGradient id="${gid}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${COLOR.emberFill}" stop-opacity="0.85"/>
      <stop offset="100%" stop-color="${COLOR.emberSoft}" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  ${rows}
</svg>`;
}

export { emptyState };
