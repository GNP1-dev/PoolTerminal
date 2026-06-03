/**
 * PoolTerminal — Mempool panel.
 *
 * Header   : current count · current bytes · 0..300% block-capacity gauge.
 * Body     : 5-minute trend sparkline (auto-scaled, gradient fill,
 *            block-boundary markers, pulsing current-value dot) + a 4-cell
 *            stats grid (NET, THROUGHPUT, AVG, PEAK).
 *
 * One sample per refresh (every 5s); rolling 60-sample buffer = 5 min.
 *
 * Throughput pulls cardano_node_metrics_txsProcessedNum_int from the
 * latest Prometheus scrape (cumulative counter — we keep the previous
 * value and divide the delta by elapsed time). Falls back to "—" if
 * Prometheus isn't enabled on this node.
 *
 * Block-boundary markers are detected by watching for tip changes
 * between successive samples — a block landing typically yanks the
 * mempool down by ~one block's worth of bytes, which is visually
 * obvious as a step-down on the sparkline aligned with the marker.
 */

import { commas } from './format.js';
import { getLastMetrics } from '../data/metrics-query.js';

const MAX_BLOCK_BODY = 90112;   // bytes (mainnet maxBlockBodySize)
const MAX_SCALE      = 300;     // header gauge runs to 300%
const MAX_SAMPLES    = 60;      // 5 min @ 5s
const SPARK_W        = 600;
const SPARK_H        = 100;

let history       = [];   // [{ ts, count, bytes, tip }]
let prevProcessed = null;
let prevProcessedTs = 0;

function byId(id) { return document.getElementById(id); }

function fmtBytes(b) {
  if (b == null) return '—';
  if (b >= 1024 * 1024) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return Math.round(b) + ' B';
}

function colorsFor(pct) {
  if (pct < 100)  return { fill: 'var(--pt-status-good)', txt: 'var(--pt-text-primary)' };
  if (pct < 200)  return { fill: 'var(--pt-status-warn)', txt: 'var(--pt-status-warn)' };
  return            { fill: 'var(--pt-status-bad)',  txt: 'var(--pt-status-bad)'  };
}

function colorTokenForBytes(b) {
  const pct = (b / MAX_BLOCK_BODY) * 100;
  if (pct < 100) return 'good';
  if (pct < 200) return 'warn';
  return 'bad';
}

function buildSparkPaths(values, maxVal) {
  const n = values.length;
  if (n === 0 || maxVal <= 0) return { line: '', fill: '' };
  const stride  = SPARK_W / Math.max(MAX_SAMPLES - 1, 1);
  const leftPad = MAX_SAMPLES - n;

  let line = '';
  values.forEach((v, i) => {
    const x = (leftPad + i) * stride;
    const y = SPARK_H - (v / maxVal) * SPARK_H;
    line += (i === 0 ? 'M' : 'L') + x.toFixed(1) + ',' + y.toFixed(1) + ' ';
  });

  const firstX = (leftPad) * stride;
  const lastX  = (leftPad + n - 1) * stride;
  const fill = line + `L${lastX.toFixed(1)},${SPARK_H} L${firstX.toFixed(1)},${SPARK_H} Z`;

  return { line, fill, lastX, lastY: SPARK_H - (values[n - 1] / maxVal) * SPARK_H };
}

function buildBlockMarkers() {
  const markers = [];
  if (history.length < 2) return markers;
  const stride  = SPARK_W / Math.max(MAX_SAMPLES - 1, 1);
  const leftPad = MAX_SAMPLES - history.length;
  for (let i = 1; i < history.length; i++) {
    if (history[i].tip != null && history[i - 1].tip != null &&
        history[i].tip !== history[i - 1].tip) {
      markers.push((leftPad + i) * stride);
    }
  }
  return markers;
}

function getMaxBytes() {
  if (history.length === 0) return MAX_BLOCK_BODY;
  const peak = Math.max(...history.map((s) => s.bytes));
  // Always show at least one block's capacity for visual context.
  return Math.max(peak * 1.1, MAX_BLOCK_BODY * 0.5);
}

function computeStats() {
  const cur = history[history.length - 1];
  if (!cur) return { net: null, throughput: null, avg: null, peak: 0 };

  // Net change over last minute (12 samples @ 5s)
  let net = null;
  const idx = Math.max(0, history.length - 13);
  const ref = history[idx];
  if (ref && ref !== cur) {
    const minutes = ((history.length - 1 - idx) * 5) / 60;
    if (minutes > 0) net = (cur.count - ref.count) / minutes;
  }

  // Throughput from Prometheus counter delta
  let throughput = null;
  const m = getLastMetrics();
  if (m && m.txsProcessed != null) {
    const now = Date.now();
    if (prevProcessed != null && now - prevProcessedTs > 1000) {
      const dt = (now - prevProcessedTs) / 1000;
      const delta = m.txsProcessed - prevProcessed;
      if (delta >= 0) throughput = delta / dt;
    }
    prevProcessed   = m.txsProcessed;
    prevProcessedTs = now;
  }

  const avg  = cur.count > 0 ? cur.bytes / cur.count : 0;
  const peak = Math.max(...history.map((s) => s.bytes));

  return { net, throughput, avg, peak };
}

function fmtNet(n) {
  if (n == null) return '—';
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)}/min`;
}

function fmtThroughput(t) {
  if (t == null) return '—';
  if (t < 0.1) return '<0.1 tx/s';
  return t.toFixed(1) + ' tx/s';
}

function renderSparkline(currentBytes) {
  const svg = byId('mp-spark');
  if (!svg) return;

  const values = history.map((s) => s.bytes);
  const maxVal = getMaxBytes();
  const { line, fill, lastX, lastY } = buildSparkPaths(values, maxVal);
  const markers = buildBlockMarkers();
  const colorKey = colorTokenForBytes(currentBytes);
  const stroke = `var(--pt-status-${colorKey})`;

  const blockCapacityY = SPARK_H - (MAX_BLOCK_BODY / maxVal) * SPARK_H;

  let parts = [];

  // Defs: vertical gradient for the area fill
  parts.push(
    `<defs>` +
      `<linearGradient id="mp-grad" x1="0" x2="0" y1="0" y2="1">` +
        `<stop offset="0%"  stop-color="${stroke}" stop-opacity="0.55"/>` +
        `<stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>` +
      `</linearGradient>` +
    `</defs>`
  );

  // Horizontal gridlines at 25/50/75% of the visible scale
  for (const f of [0.25, 0.5, 0.75]) {
    const y = SPARK_H * (1 - f);
    parts.push(`<line x1="0" y1="${y}" x2="${SPARK_W}" y2="${y}" class="pt-mp-grid"/>`);
  }

  // One-block-capacity reference line (helps eye-pick when we're over a block)
  if (blockCapacityY >= 0 && blockCapacityY <= SPARK_H) {
    parts.push(
      `<line x1="0" y1="${blockCapacityY.toFixed(1)}" ` +
      `x2="${SPARK_W}" y2="${blockCapacityY.toFixed(1)}" class="pt-mp-capline"/>`
    );
  }

  // Block-boundary markers
  for (const x of markers) {
    parts.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${SPARK_H}" class="pt-mp-block-marker"/>`);
  }

  // Filled area
  if (fill) parts.push(`<path d="${fill}" fill="url(#mp-grad)" stroke="none"/>`);
  // Sharp line on top
  if (line) parts.push(`<path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`);

  // Pulsing current-value indicator
  if (lastX != null) {
    parts.push(
      `<circle class="pt-mp-current" cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" ` +
      `r="3" fill="${stroke}"/>`
    );
  }

  svg.innerHTML = parts.join('');
}

function renderStats() {
  const { net, throughput, avg, peak } = computeStats();
  byId('mp-stat-net').textContent        = fmtNet(net);
  byId('mp-stat-throughput').textContent = fmtThroughput(throughput);
  byId('mp-stat-avg').textContent        = avg ? fmtBytes(avg) : '—';
  byId('mp-stat-peak').textContent       = fmtBytes(peak);
}

function ensureBody() {
  const body = byId('mp-body');
  if (!body) return;
  if (body.dataset.spark === '1') return;
  body.dataset.spark = '1';
  body.innerHTML =
    `<svg id="mp-spark" class="pt-mp-spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none"></svg>` +
    `<div class="pt-mp-stats-grid">` +
      `<div class="pt-mp-stat"><div class="pt-mp-stat-label">Net</div><div class="pt-mp-stat-val" id="mp-stat-net">—</div></div>` +
      `<div class="pt-mp-stat"><div class="pt-mp-stat-label">Throughput</div><div class="pt-mp-stat-val" id="mp-stat-throughput">—</div></div>` +
      `<div class="pt-mp-stat"><div class="pt-mp-stat-label">Avg tx</div><div class="pt-mp-stat-val" id="mp-stat-avg">—</div></div>` +
      `<div class="pt-mp-stat"><div class="pt-mp-stat-label">Peak (5m)</div><div class="pt-mp-stat-val" id="mp-stat-peak">—</div></div>` +
    `</div>`;
}

/**
 * Render the mempool panel.
 *   mp      : { txCount, totalBytes, recent?: [] } from the data source
 *   opts.tipBlock : current tip block number (for block-boundary markers)
 */
export function renderMempool(mp, opts = {}) {
  const countEl = byId('mp-count');
  if (!countEl) return;

  const pct = (mp.totalBytes / MAX_BLOCK_BODY) * 100;
  const trackPct = Math.min((pct / MAX_SCALE) * 100, 100);
  const { fill, txt } = colorsFor(pct);
  const left = mp.txCount === 0 ? 'empty' : `${mp.txCount} tx · ${fmtBytes(mp.totalBytes)}`;

  countEl.innerHTML = `
    <span class="pt-muted">${left}</span>
    <span class="pt-mp-gauge">
      <span class="pt-mp-gauge-track">
        <span class="pt-mp-gauge-fill" style="width:${trackPct.toFixed(1)}%; background:${fill};"></span>
      </span>
      <span class="pt-mp-gauge-pct" style="color:${txt};">${Math.round(pct)}%</span>
    </span>`;

  // Append to rolling history
  history.push({
    ts:    Date.now(),
    count: mp.txCount,
    bytes: mp.totalBytes,
    tip:   opts.tipBlock ?? null,
  });
  while (history.length > MAX_SAMPLES) history.shift();

  ensureBody();
  renderSparkline(mp.totalBytes);
  renderStats();
}

/** Reset on disconnect / view re-mount so a new session doesn't inherit history. */
export function resetMempool() {
  history = [];
  prevProcessed   = null;
  prevProcessedTs = 0;
}
