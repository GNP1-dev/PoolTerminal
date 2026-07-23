/**
 * PoolTerminal — Mempool panel.
 *
 * Header   : current count · current bytes / capacity · 0..100% fill gauge.
 *            Fill % is measured against the node's real reported mempool
 *            capacity (capacityInBytes), so it is a true 0..100% and can never
 *            exceed a full mempool.
 * Body     : 5-minute trend sparkline (y-axis = mempool capacity, gradient
 *            fill, one-block reference line, block-boundary markers, pulsing
 *            current-value dot) + a 4-cell stats grid (NET, THROUGHPUT, AVG,
 *            PEAK). THROUGHPUT is the tx-processed rate averaged over the whole
 *            window (txs clear only when blocks land, so a single sample is
 *            mostly zero).
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

const MAX_BLOCK_BODY   = 90112;   // bytes = one block body (mainnet maxBlockBodySize)
// Congestion is measured the way the NETWORK treats the mempool. A stock node
// runs a 2-block mempool (~176 KB) and rejects transactions once full, so
// 2 blocks = 100% "network full". We measure backlog against this, not against
// a node's local mempoolCapacityOverride (which can be many MB and means
// nothing to the network - a raised override just lets THIS node hold what a
// default node would already be rejecting). /*mp-network-scale*/
const PRACTICAL_FULL   = 2 * MAX_BLOCK_BODY;   // 176 KB = 100% (default network mempool full)
const MAX_SAMPLES      = 60;      // 5 min @ 5s
const SPARK_W          = 600;
const SPARK_H          = 240;   // taller viewBox (2.5:1) so preserveAspectRatio=none stretches text far less /*mp-tallbox*/

// The node's real mempool capacity (capacityInBytes), kept for context/display
// only - NOT used as the gauge denominator (see above). /*mp-realcap*/

let history       = [];   // [{ ts, count, bytes, tip }]
let _lastMpState  = null; // { congestionPct, blocks } for the alerts engine

// Latest mempool congestion snapshot, for the alerts engine. /*mp-alert-state*/
export function getMempoolState() { return _lastMpState; }

function byId(id) { return document.getElementById(id); }

function fmtBytes(b) {
  if (b == null) return '—';
  if (b >= 1024 * 1024) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return Math.round(b) + ' B';
}

function colorsFor(pct) {
  if (pct < 50)   return { fill: 'var(--pt-status-good)', txt: 'var(--pt-text-primary)' };
  if (pct < 85)   return { fill: 'var(--pt-status-warn)', txt: 'var(--pt-status-warn)' };
  return            { fill: 'var(--pt-status-bad)',  txt: 'var(--pt-status-bad)'  };
}

function colorTokenForBytes(b) {
  const pct = (b / PRACTICAL_FULL) * 100;
  if (pct < 50) return 'good';
  if (pct < 85) return 'warn';
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
  // Y-axis is a FIXED 0..100% of network-full (2 blocks / 176 KB). 100% = the
  // point a default node rejects, and the coloured strip fills the whole left
  // edge. The axis only extends above 100% while the mempool is CURRENTLY in
  // overflow (the latest sample past 2 blocks) - a past overflow spike must not
  // keep the axis zoomed out. /*mp-scale-networkfull*/
  const cur = history.length ? history[history.length - 1].bytes : 0;
  if (cur <= PRACTICAL_FULL) return PRACTICAL_FULL;           // normal: axis = exactly 0-100%
  const overPct = cur / PRACTICAL_FULL;                       // >1 = currently overflowing
  const capped = Math.ceil(overPct / 0.25) * 0.25;            // next 25% step
  return PRACTICAL_FULL * capped;
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

  // Throughput = rate txs are PROCESSED (removed from mempool as blocks are
  // forged), from the cumulative txsProcessedNum counter. Computed over two
  // windows: 5m (whole buffer, smooth sustained rate) and 1m (last ~12 samples,
  // more responsive). Txs only clear when a block lands (~every 20s), so a
  // single sample is mostly zero - both windows average over minutes.
  // /*mp-throughput-window*/
  function rateOver(samples) {
    const proc = samples.filter((s) => s.processed != null);
    if (proc.length < 2) return null;
    const first = proc[0], last = proc[proc.length - 1];
    const dtSec = (last.ts - first.ts) / 1000;
    const dCount = last.processed - first.processed;
    return (dtSec > 0 && dCount >= 0) ? dCount / dtSec : null;
  }
  const throughput   = rateOver(history);                       // ~5 min
  const throughput1m = rateOver(history.slice(-13));            // ~1 min (12 samples @ 5s)

  const avg  = cur.count > 0 ? cur.bytes / cur.count : 0;
  const peak = Math.max(...history.map((s) => s.bytes));

  return { net, throughput, throughput1m, avg, peak };
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
  // Data-flow series (cyan): KB arriving in the trailing ~60s per sample. /*mp-flowtrace-v51*/
  const FLOW_MAX_KB = 300;
  const flowVals = history.map((s, i) => {
    let arr = 0; const st = Math.max(1, i - 11);
    for (let j = st; j <= i; j++) { const d = history[j].bytes - history[j - 1].bytes; if (d > 0) arr += d; }
    return arr / 1024;
  });
  const maxVal = getMaxBytes();
  const { line, fill, lastX, lastY } = buildSparkPaths(values, maxVal);
  const markers = buildBlockMarkers();
  const colorKey = colorTokenForBytes(currentBytes);
  const stroke = `var(--pt-status-${colorKey})`;

  let parts = [];

  // Defs: vertical gradient for the area fill + the coloured axis-strip gradient
  parts.push(
    `<defs>` +
      `<linearGradient id="mp-grad" x1="0" x2="0" y1="0" y2="1">` +
        `<stop offset="0%"  stop-color="${stroke}" stop-opacity="0.55"/>` +
        `<stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>` +
      `</linearGradient>` +
      // Axis colour strip: green 0-50%, orange 50-75%, light-red 75-90%, red 90-100%.
      // (y=0 is top=100%, y=SPARK_H is bottom=0%, so stops are reversed.)
      `<linearGradient id="mp-axis" x1="0" x2="0" y1="0" y2="1">` +
        `<stop offset="0%"   stop-color="#ef4444"/>` +   /* 100% */
        `<stop offset="10%"  stop-color="#ef4444"/>` +   /* 90%  */
        `<stop offset="25%"  stop-color="#f87171"/>` +   /* 75%  light red */
        `<stop offset="50%"  stop-color="#f59e0b"/>` +   /* 50%  orange */
        `<stop offset="100%" stop-color="#10b981"/>` +   /* 0%   green */
      `</linearGradient>` +
    `</defs>`
  );

  // How much of the visible axis is the 0-100% network band vs overflow above.
  const networkFullY = SPARK_H - (PRACTICAL_FULL / maxVal) * SPARK_H;   // y of the 100% line
  const inOverflow = maxVal > PRACTICAL_FULL;

  // Overflow zone shading (above the 100% line) when this node holds past 2 blocks.
  if (inOverflow && networkFullY > 1) {
    parts.push(`<rect x="0" y="0" width="${SPARK_W}" height="${networkFullY.toFixed(1)}" fill="#7f1d1d" opacity="0.18"/>`);
  }

  // Coloured axis strip down the left edge (0-100% band only).
  const STRIP_W = 8;
  parts.push(`<rect x="0" y="${networkFullY.toFixed(1)}" width="${STRIP_W}" height="${(SPARK_H - networkFullY).toFixed(1)}" fill="url(#mp-axis)" rx="1"/>`);

  // Percentage guidelines within the 0-100% band. Drawn with explicit visible
  // strokes (the CSS grid class is near-invisible) and consistent label offsets
  // so 25/50/75/100 read evenly. The 50% = 1-block line is drawn later, on top
  // of the fill. /*mp-grid-visible*/
  const gridStroke = 'rgba(160,180,210,0.28)';
  for (const f of [0.25, 0.75]) {
    const y = SPARK_H - f * (PRACTICAL_FULL / maxVal) * SPARK_H;
    parts.push(`<line x1="${STRIP_W + 2}" y1="${y.toFixed(1)}" x2="${SPARK_W}" y2="${y.toFixed(1)}" stroke="${gridStroke}" stroke-width="1" stroke-dasharray="5 5"/>`);
    parts.push(`<text x="${STRIP_W + 5}" y="${(y - 5).toFixed(1)}" style="fill:#9db0cc;font-size:13px;font-weight:600;font-family:ui-monospace,monospace;opacity:.85">${Math.round(f * 100)}%</text>`);
  }
  // The 100% network-full line (solid red) + label.
  parts.push(`<line x1="${STRIP_W + 2}" y1="${Math.max(1, networkFullY).toFixed(1)}" x2="${SPARK_W}" y2="${Math.max(1, networkFullY).toFixed(1)}" stroke="#ef4444" stroke-width="1.5" opacity="0.85"/>`);
  parts.push(`<text x="${STRIP_W + 5}" y="${Math.max(16, networkFullY + 16).toFixed(1)}" style="fill:#ef4444;font-size:15px;font-weight:800;font-family:ui-monospace,monospace;opacity:.95">100% FULL</text>`);
  // Overflow label at the very top when applicable.
  if (inOverflow) {
    const overPct = Math.round((maxVal / PRACTICAL_FULL) * 100);
    parts.push(`<text x="${STRIP_W + 5}" y="16" style="fill:#fca5a5;font-size:13px;font-weight:600;font-family:ui-monospace,monospace;opacity:.9">overflow ${overPct}%</text>`);
  }

  // Block-boundary markers
  for (const x of markers) {
    parts.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${SPARK_H}" class="pt-mp-block-marker"/>`);
  }

  // Filled area
  if (fill) parts.push(`<path d="${fill}" fill="url(#mp-grad)" stroke="none"/>`);
  // Sharp line on top
  if (line) parts.push(`<path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`);

  // The 50% line = exactly one block (100% = 2 blocks). Drawn ON TOP of the fill
  // so it stays visible, as a bright amber dashed line. /*mp-1block-line*/
  {
    const y = SPARK_H - 0.5 * (PRACTICAL_FULL / maxVal) * SPARK_H;
    parts.push(`<line x1="${STRIP_W + 2}" y1="${y.toFixed(1)}" x2="${SPARK_W}" y2="${y.toFixed(1)}" stroke="#e0b84a" stroke-width="1.8" stroke-dasharray="6 5" opacity="0.95"/>`);
    parts.push(`<text x="${STRIP_W + 5}" y="${(y - 5).toFixed(1)}" style="fill:#e0b84a;font-size:13px;font-weight:700;font-family:ui-monospace,monospace;opacity:.95">1 block</text>`);
  }

  // Data-flow trace (cyan) on its own 0-300 KB/min right-hand axis.
  const flowLine = buildSparkPaths(flowVals, FLOW_MAX_KB).line;
  if (flowLine) parts.push(`<path d="${flowLine}" fill="none" stroke="#2dd4ee" stroke-width="1.3" opacity="0.9"/>`);
  parts.push(`<text x="${(SPARK_W - 4)}" y="24" text-anchor="end" style="fill:#2dd4ee;font-size:20px;font-weight:600;font-family:ui-monospace,monospace;opacity:.9">300</text>`);
  parts.push(`<text x="${(SPARK_W - 4)}" y="${(SPARK_H / 2 + 3).toFixed(0)}" text-anchor="end" style="fill:#2dd4ee;font-size:18px;font-family:ui-monospace,monospace;opacity:.6">150</text>`);
  parts.push(`<text x="${(SPARK_W - 4)}" y="${(SPARK_H - 3).toFixed(0)}" text-anchor="end" style="fill:#2dd4ee;font-size:18px;font-family:ui-monospace,monospace;opacity:.75">KB/m</text>`);

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
// v2: peaks are now stored as true fill-% of the node's real capacity (bounded
// 0..100). v1 stored values scaled against a hardcoded 176 KB cap, which could
// exceed 100% - discard those by versioning the key. /*mp-peaks-v2*/
const PEAKS_KEY = 'pt.mempool.peaks.v2';
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
  // Backlog beyond the 2-block practical full (>100%) is real, useful info
  // (the mempool is holding more than two blocks can clear). Keep it, but cap
  // at a sane ceiling so a transient spike can't store an absurd value.
  if (pct > 999) pct = 999;   /*mp-peak-clamp*/
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
  const { net, throughput, throughput1m, avg, peak } = computeStats();
  byId('mp-stat-net').textContent        = fmtNet(net);
  byId('mp-stat-throughput').textContent = fmtThroughput(throughput);
  const t1 = byId('mp-stat-throughput1m'); if (t1) t1.textContent = fmtThroughput(throughput1m);
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
  // Only the chart lives here now. The NET/THROUGHPUT/AVG/PEAK and MAX% stats
  // are rendered in the panel's right-hand stat column (now2.js) using the same
  // element IDs, which renderStats()/renderPeaksInline() populate. /*mp-statcol*/
  body.innerHTML =
    `<svg id="mp-spark" class="pt-mp-spark" viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none"></svg>`;
}

/**
 * Render the mempool panel.
 *   mp   : { txCount, totalBytes, capacityBytes?, recent? } from the data source
 *   opts.tipBlock : current tip block number (for block-boundary markers)
 *
 * Accuracy model (confirmed against IOHK docs):
 *  - The mempool is a fixed-size buffer. Its real ceiling is the node's
 *    capacityInBytes (default = 2x max block body ~176 KB, but configurable via
 *    MempoolCapacityBytesOverride). Txs are only rejected at THAT ceiling.
 *  - What matters operationally is the BACKLOG relative to block-clearing
 *    capacity: how many blocks' worth of tx are queued. 1 block = ~88 KB.
 *  - So the gauge shows blocks-queued (congestion), and we also show true fill
 *    vs the node's real capacity (how close to actually rejecting txs).
 */
export function renderMempool(mp, opts = {}) {
  const countEl = byId('mp-count');
  if (!countEl) return;

  // Congestion is measured the way the NETWORK treats it: backlog vs
  // block-clearing capacity. One block body (~88 KB, the protocol
  // maxBlockBodySize) is what a single block clears. The default network
  // mempool is 2 blocks (~176 KB) - the point at which a stock node stops
  // accepting and starts rejecting transactions. So:
  //   blocks queued = bytes / maxBlockBodySize
  //   congestion %  = fill vs the 2-block network default (100% = a default
  //                   node is full and rejecting).
  const blocks = mp.totalBytes / MAX_BLOCK_BODY;
  const congestionPct = (mp.totalBytes / PRACTICAL_FULL) * 100;   // vs 2-block network default
  _lastMpState = { congestionPct, blocks };   // expose for alerts engine /*mp-alert-state*/

  // MAX% row tracks congestion peaks (meaningful, network-relative).
  recordPeak(congestionPct);

  // Emit stats as data attributes; the visible stat line is rendered on the
  // MEMPOOL bar header (now2.js) to avoid a redundant top row. /*mp-inline-stats*/
  countEl.innerHTML = `
    <span class="pt-mp-stats" data-txs="${mp.txCount}" data-bytes="${mp.totalBytes}" data-blocks="${blocks.toFixed(2)}" data-congestion="${congestionPct.toFixed(1)}"></span>`;

  // Append to rolling history. Capture the cumulative txsProcessed counter so
  // throughput can be averaged over the whole window. /*mp-throughput-window*/
  const lm = getLastMetrics();
  history.push({
    ts:        Date.now(),
    count:     mp.txCount,
    bytes:     mp.totalBytes,
    tip:       opts.tipBlock ?? null,
    processed: (lm && lm.txsProcessed != null) ? lm.txsProcessed : null,
  });
  while (history.length > MAX_SAMPLES) history.shift();

  ensureBody();
  renderSparkline(mp.totalBytes);
  renderStats();
}

/** Reset on disconnect / view re-mount so a new session doesn't inherit history. */
export function resetMempool() {
  history = [];
}
