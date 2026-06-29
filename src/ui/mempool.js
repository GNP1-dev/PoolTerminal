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
import { getMode } from '../data/index.js';

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
  // Scale in whole-block (100%) steps: 0-100% normally, stepping up to
  // 200%, 300%, ... as the mempool fills past a block body.
  const blocks = Math.max(1, Math.ceil(peak / MAX_BLOCK_BODY));
  return blocks * MAX_BLOCK_BODY;
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

  // Horizontal guidelines + bold % labels at each 100% (one-block) boundary.
  const scaleBlocks = Math.round(maxVal / MAX_BLOCK_BODY);
  if (scaleBlocks <= 2) {
    for (let b = 0; b < scaleBlocks; b++) {
      const yh = SPARK_H * (1 - (b + 0.5) / scaleBlocks);
      parts.push(`<line x1="0" y1="${yh.toFixed(1)}" x2="${SPARK_W}" y2="${yh.toFixed(1)}" class="pt-mp-grid" stroke-dasharray="3 4"/>`);
    }
  }
  for (let b = 1; b <= scaleBlocks; b++) {
    const y = b === scaleBlocks ? 0.8 : SPARK_H * (1 - b / scaleBlocks);
    const cls = b === 1 ? 'pt-mp-capline' : 'pt-mp-grid';
    parts.push(`<line x1="0" y1="${y.toFixed(1)}" x2="${SPARK_W}" y2="${y.toFixed(1)}" class="${cls}"/>`);
    parts.push(`<text x="5" y="${Math.max(12, y + 12).toFixed(1)}" style="fill:#aebfe0;font-size:11px;font-weight:600;font-family:ui-monospace,monospace;opacity:.92">${b * 100}%</text>`);
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

// --- persistent mempool high-water marks (5m / 1h / 24h / all-time) ---
const PEAKS_KEY = 'pt.mempool.peaks.v1';
let peaks = null;
let peaksLoaded = false;
let lastPeakSave = 0;

function loadPeaks() {
  if (peaksLoaded) return;
  peaksLoaded = true;
  peaks = { allTime: { pct: 0, t: 0 }, mins: {} };
  try {
    const raw = localStorage.getItem(PEAKS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        if (p.allTime && typeof p.allTime.pct === 'number') peaks.allTime = p.allTime;
        if (p.mins && typeof p.mins === 'object') peaks.mins = p.mins;
      }
    }
  } catch (e) { /* ignore corrupt/absent */ }
  prunePeaks();
}

function prunePeaks() {
  const cutoff = Math.floor((Date.now() - 24 * 3600 * 1000) / 60000);
  for (const k of Object.keys(peaks.mins)) {
    if (Number(k) < cutoff) delete peaks.mins[k];
  }
}

function savePeaks() {
  const now = Date.now();
  if (now - lastPeakSave < 5000) return;
  lastPeakSave = now;
  try { localStorage.setItem(PEAKS_KEY, JSON.stringify(peaks)); } catch (e) { /* ignore */ }
}

function recordPeak(pct) {
  // Never let demo-mode's synthetic mempool pollute the persisted peaks
  // that carry into real connections. /*demo-peak-guard*/
  if (getMode() === 'demo') return;
  loadPeaks();
  if (!isFinite(pct) || pct <= 0) return;
  const now = Date.now();
  let changed = false;
  if (pct > (peaks.allTime.pct || 0)) { peaks.allTime = { pct, t: now }; changed = true; }
  const m = Math.floor(now / 60000);
  if (pct > (peaks.mins[m] || 0)) { peaks.mins[m] = pct; changed = true; }
  prunePeaks();
  if (changed) savePeaks();
}

function maxOverMins(windowMs) {
  loadPeaks();
  const cutoff = Math.floor((Date.now() - windowMs) / 60000);
  let max = 0;
  for (const [k, v] of Object.entries(peaks.mins)) {
    if (Number(k) >= cutoff && v > max) max = v;
  }
  return max;
}

function renderStats() {
  const { net, throughput, avg, peak } = computeStats();
  byId('mp-stat-net').textContent        = fmtNet(net);
  byId('mp-stat-throughput').textContent = fmtThroughput(throughput);
  byId('mp-stat-avg').textContent        = avg ? fmtBytes(avg) : '—';
  byId('mp-stat-peak').textContent       = fmtBytes(peak);
  const fmtP = v => v > 0 ? Math.round(v) + '%' : '\u2014';
  const e5 = byId('mp-peak-5m'); if (e5) e5.textContent = fmtP(maxOverMins(5 * 60000));
  const e1 = byId('mp-peak-1h'); if (e1) e1.textContent = fmtP(maxOverMins(60 * 60000));
  const e24 = byId('mp-peak-24h'); if (e24) e24.textContent = fmtP(maxOverMins(24 * 3600 * 1000));
  const ea = byId('mp-peak-all');
  if (ea) { const ath = peaks ? (peaks.allTime.pct || 0) : 0; ea.textContent = fmtP(ath); if (peaks && peaks.allTime.t) ea.title = 'reached ' + new Date(peaks.allTime.t).toLocaleString(); }
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
    `</div>` +
    `<div class="pt-mp-peaks" style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-top:8px;padding-top:7px;border-top:1px solid rgba(135,165,215,.18);font-size:10.5px;white-space:nowrap;">` +
      `<span style="color:#6f7d99;letter-spacing:.5px;">MAX %</span>` +
      `<span style="color:#6f7d99;">5m&nbsp;<b id="mp-peak-5m" style="color:#36e0d4;font-family:ui-monospace,monospace;font-weight:700;">—</b></span>` +
      `<span style="color:#6f7d99;">1h&nbsp;<b id="mp-peak-1h" style="color:#5dff9b;font-family:ui-monospace,monospace;font-weight:700;">—</b></span>` +
      `<span style="color:#6f7d99;">24h&nbsp;<b id="mp-peak-24h" style="color:#ffc24a;font-family:ui-monospace,monospace;font-weight:700;">—</b></span>` +
      `<span style="color:#6f7d99;">all&nbsp;<b id="mp-peak-all" style="color:#ff7a4c;font-family:ui-monospace,monospace;font-weight:700;">—</b></span>` +
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
  recordPeak(pct);
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
