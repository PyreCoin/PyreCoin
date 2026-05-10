// Renders the four large chart panels under "BY THE NUMBERS":
//   - #chart-price      → hourly OHLC candles
//   - #chart-visitors   → hourly visitor bars
//   - #chart-burns      → hourly burn-volume bars
//   - #chart-countries  → top-N countries (horizontal bars)
//
// Data is provided by stats.js; this module is a pure renderer plus
// the 1d/3d/10d toggle handling. State of the toggle persists across
// stats.js refresh ticks (without it, every 30s tick would clobber a
// user's chosen range).

import { $ } from './utils.js';

// Same cache-bust pattern as stats.js — see §7.1. charts.js is the
// only non-stable transitive dep here; pulling its V off our own
// module URL keeps it on the same version stats.js loaded under.
const V = (() => {
  try { return new URL(import.meta.url).searchParams.get('v') || ''; }
  catch (_) { return ''; }
})();
const _chartsMod = await import(`./charts.js?v=${V}`);
const { candlestick, histogramBars, horizontalBars, emptyState } = _chartsMod;

// Latest data, kept so toggle clicks can re-render without forcing a
// full /price-history + /analytics refetch.
let _data = {
  priceHistory: null,         // raw GeckoTerminal OHLCV (newest-first)
  hourlyBurns:  null,         // length WINDOW_HOURS (oldest → newest)
  hourlyVisits: null,         // length WINDOW_HOURS (oldest → newest)
  topCountries: null,         // [{label, value}, ...]
  analyticsConfigured: null,  // true = secrets set, just no data yet (warming up);
                              // false = worker says note='not configured';
                              // null = analytics fetch outright failed
};

// Per-panel current range (in HOURS). Default = 240 (10 days).
const _range = {
  'chart-price':    240,
  'chart-visitors': 240,
  'chart-burns':    240,
};

// Wire the 1d/3d/10d toggle buttons exactly once. Called lazily on
// first render so we don't run before the DOM nodes exist.
let _togglesWired = false;
function wireToggles(){
  if (_togglesWired) return;
  document.querySelectorAll('.chart-panel-toggle').forEach(toggleEl => {
    const target = toggleEl.dataset.target;
    if (!target) return;
    toggleEl.querySelectorAll('.chart-range').forEach(btn => {
      btn.addEventListener('click', () => {
        const r = parseInt(btn.dataset.range, 10);
        if (!isFinite(r) || r <= 0) return;
        _range[target] = r;
        // Update button "active" state inside this toggle group.
        toggleEl.querySelectorAll('.chart-range').forEach(b =>
          b.classList.toggle('active', b === btn)
        );
        renderPanel(target);
        renderFoot(target);
      });
    });
  });
  _togglesWired = true;
}

// ── renderers per panel ──────────────────────────────────────────

function renderPriceChart(){
  const el = $('chart-price');
  if (!el) return;
  if (!Array.isArray(_data.priceHistory) || _data.priceHistory.length === 0) {
    emptyState(el, 'no price candles yet · check back soon');
    return;
  }
  // GT returns newest-first; convert to oldest-first for left-to-right
  // time-axis rendering. Then trim to the current range from the right.
  const ascending = _data.priceHistory.slice().sort((a, b) => a[0] - b[0]);
  const range = _range['chart-price'];
  const trimmed = ascending.slice(-range);
  candlestick(el, trimmed, { height: el.clientHeight || 240 });
}

function renderVisitorsChart(){
  const el = $('chart-visitors');
  if (!el) return;
  const series = _data.hourlyVisits;
  if (!Array.isArray(series) || series.length === 0 || series.every(v => v == null)) {
    emptyState(el, analyticsEmptyMessage());
    return;
  }
  const range = _range['chart-visitors'];
  const trimmed = series.slice(-range).map(v => v == null ? 0 : v);
  histogramBars(el, trimmed, {
    height: el.clientHeight || 240,
    formatTooltip: (i, v) => `bucket ${i}: ${v} views`,
    formatY: v => Math.round(v).toLocaleString(),
  });
}

function renderBurnsChart(){
  const el = $('chart-burns');
  if (!el) return;
  const series = _data.hourlyBurns;
  if (!Array.isArray(series) || series.length === 0) {
    emptyState(el, 'no burns in this window');
    return;
  }
  const range = _range['chart-burns'];
  const trimmed = series.slice(-range);
  histogramBars(el, trimmed, {
    height: el.clientHeight || 240,
    formatTooltip: (i, v) => `bucket ${i}: ${Math.round(v).toLocaleString()} $PYRE`,
    formatY: v => v >= 1e6 ? (v/1e6).toFixed(1) + 'M'
                : v >= 1e3 ? (v/1e3).toFixed(0) + 'K'
                : Math.round(v).toString(),
  });
}

function renderCountriesChart(){
  const el = $('chart-countries');
  if (!el) return;
  const items = _data.topCountries;
  if (!Array.isArray(items) || items.length === 0) {
    emptyState(el, analyticsEmptyMessage());
    return;
  }
  horizontalBars(el, items, { limit: 10 });
}

// Centralized empty-state copy for the two CF-analytics panels. Three
// shapes depending on what the worker / fetch reported:
//   true  → secrets are set, GraphQL call succeeded, just no data
//           in CF's bucket yet (warmup window — typical 15-30 min,
//           sometimes longer first time)
//   false → worker explicitly returned note='not configured', i.e.
//           one of the CF_* secrets is missing
//   null  → /analytics fetch outright failed (502, network blip,
//           worker down) — wait for next 30s tick
function analyticsEmptyMessage(){
  if (_data.analyticsConfigured === false) {
    return 'visitor analytics not configured yet · paste your CF Web Analytics token in index.html, set CF_ANALYTICS_TOKEN / CF_ACCOUNT_ID / CF_SITE_TAG worker secrets, then redeploy';
  }
  if (_data.analyticsConfigured === null) {
    return 'analytics endpoint unreachable · retrying on the next refresh tick';
  }
  return 'warming up · cloudflare web analytics typically takes 15-30 minutes after the first beacon hit before data surfaces through their graphql api · be patient';
}

function renderPanel(target){
  if (target === 'chart-price')    return renderPriceChart();
  if (target === 'chart-visitors') return renderVisitorsChart();
  if (target === 'chart-burns')    return renderBurnsChart();
}

// Update the "last X days · ..." footer for time-series panels so it
// reflects the active toggle. Country panel has a fixed footer.
function renderFoot(target){
  const r = _range[target];
  if (r == null) return;
  const label = r >= 240 ? 'last 10 days'
              : r >= 168 ? 'last 7 days'
              : r >= 72  ? 'last 3 days'
              : r >= 24  ? 'last 24 hours'
              : `last ${r} hours`;
  const map = {
    'chart-price':    [`${label} · USD · pump-fun pool · data via geckoterminal.com`, 'chart-price-foot'],
    'chart-visitors': [`${label} · page views per hour · cookieless, via cloudflare web analytics`, 'chart-visitors-foot'],
    'chart-burns':    [`${label} · $PYRE burned per hour · derived from leaderboard.json`, 'chart-burns-foot'],
  };
  const entry = map[target];
  if (!entry) return;
  const el = $(entry[1]);
  if (el) el.textContent = entry[0];
}

// ── public ────────────────────────────────────────────────────────

export function renderBigCharts(data){
  // Update internal state. Defaults to nulls when stats.js can't
  // produce a series (e.g. placeholder mint, fetch failure).
  _data.priceHistory       = data?.priceHistory       || null;
  _data.hourlyBurns        = data?.hourlyBurns        || null;
  _data.hourlyVisits       = data?.hourlyVisits       || null;
  _data.topCountries       = data?.topCountries       || null;
  _data.analyticsConfigured = (data?.analyticsConfigured === undefined) ? null : data.analyticsConfigured;

  wireToggles();

  renderPriceChart();
  renderVisitorsChart();
  renderBurnsChart();
  renderCountriesChart();

  ['chart-price','chart-visitors','chart-burns'].forEach(renderFoot);
}
