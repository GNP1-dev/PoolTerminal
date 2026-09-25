/**
 * PoolTerminal — Mempool panel.
 *
 * Units (item 18): the queue is measured in BLOCKS, bytes / maxBlockBodySize
 * (one block = 88 KB). The key level is 2 blocks. A default mempool is 2 × max
 * block body, and most pools run the default, so from 2 blocks queued most of
 * the network starts rejecting new transactions, whatever this node's own
 * capacity is. Blocks-queued figures are coloured by that level (format.js
 * blkLevel: normal / approaching 2 / 2+). % is used only for fill of THIS
 * node's real capacity (capacityInBytes, e.g. a 64 MB override), shown as a
 * small secondary line ("0.5% of 64 MB", "—" when the node didn't report it).
 *
 * Bar     : MEMPOOL bar in now2.js, 0..2 blocks, fed by the data attributes
 *           renderMempool() writes on #mp-count.
 * Chart   : 5-minute sparkline. Y-axis is 0..2 blocks (extends while the
 *           queue is currently over 2), with the 1-block line and the
 *           prominent "2 blocks: default mempools full" line; block-boundary
 *           markers; cyan data-flow trace on its own KB/min axis.
 * Stats   : NET, TX RATE 1m/5m, AVG tx size, PEAK 5m (blocks), and the
 *           MAX (blocks) column: persisted peaks for 5m / 1h / 24h / all, with
 *           the all-time peak's date shown inline.
 *
 * One sample per refresh (every 5s); rolling 60-sample buffer = 5 min.
 *
 * Throughput pulls txsProcessedNum_counter from the latest Prometheus scrape
 * (cumulative counter — we keep the previous value and divide the delta by
 * elapsed time). Falls back to "—" if no metrics endpoint was found.
 *
 * Block-boundary markers are detected by watching for tip changes
 * between successive samples — a block landing typically yanks the
 * mempool down by ~one block's worth of bytes, which is visually
 * obvious as a step-down on the sparkline aligned with the marker.
 */

import { commas, fmtBlk, blkLevel, fmtCapFill, MAX_BLOCK_BODY, DEFAULT_MEMPOOL_BLOCKS } from './format.js';
import { getLastMetrics } from '../data/metrics-query.js';
import { getMode } from '../data/index.js';

// The queue is measured the way the NETWORK treats it: a default node's mempool
// is 2 blocks (~176 KB) and it rejects transactions once full. A raised local
// override (many MB) only lets THIS node hold what default nodes are already
// rejecting, so the 2-block level stays the headline. /*mp-network-scale*/
const PRACTICAL_FULL   = DEFAULT_MEMPOOL_BLOCKS * MAX_BLOCK_BODY;   // 176 KB = 2 blocks
const MAX_SAMPLES      = 60;      // 5 min @ 5s
const SPARK_W          = 600;
const SPARK_H          = 240;   // taller viewBox (2.5:1) so preserveAspectRatio=none stretches text far less /*mp-tallbox*/

// The node's real mempool capacity (capacityInBytes) is shown only as the
// secondary "x% of N MB" fill line, never as the queue scale. /*mp-realcap*/

let history       = [];   // [{ ts, count, bytes, tip }]
let _lastMpState  = null; // { congestionPct, blocks, capFillPct } for the alerts engine

// Latest mempool congestion snapshot, for the alerts engine. /*mp-alert-state*/
export function getMempoolState() { return _lastMpState; }

function byId(id) { return document.getElementById(id); }

function fmtBytes(b) {
  if (b == null) return '—';
  if (b >= 1024 * 1024) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return Math.round(b) + ' B';
}

function colorTokenForBytes(b) {
  return blkLevel(b / MAX_BLOCK_BODY);   // normal / approaching 2 / 2+ blocks
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
  // Y-axis is a FIXED 0..2 blocks (176 KB), the point default mempools are
  // full, and the coloured strip fills the whole left edge. The axis only
  // extends above 2 blocks while the queue is CURRENTLY over it (the latest
  // sample) - a past spike must not keep the axis zoomed out. /*mp-scale-networkfull*/
  const cur = history.length ? history[history.length - 1].bytes : 0;
  if (cur <= PRACTICAL_FULL) return PRACTICAL_FULL;           // normal: axis = exactly 0-2 blocks
  const overPct = cur / PRACTICAL_FULL;                       // >1 = currently over 2 blocks
  const capped = Math.ceil(overPct / 0.25) * 0.25;            // next half-block step
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
      // Axis colour strip, same levels as blkLevel(): green below 1.5 blocks,
      // amber approaching 2, red at the 2-block line.
      // (y=0 is top = 2 blocks, y=SPARK_H is bottom = 0, so stops are reversed.)
      `<linearGradient id="mp-axis" x1="0" x2="0" y1="0" y2="1">` +
        `<stop offset="0%"   stop-color="#ef4444"/>` +   /* 2 blocks   */
        `<stop offset="8%"   stop-color="#f59e0b"/>` +   /*            */
        `<stop offset="25%"  stop-color="#f59e0b"/>` +   /* 1.5 blocks */
        `<stop offset="32%"  stop-color="#10b981"/>` +   /*            */
        `<stop offset="100%" stop-color="#10b981"/>` +   /* 0          */
      `</linearGradient>` +
    `</defs>`
  );

  // How much of the visible axis is the 0-2 block band vs the part above it.
  const networkFullY = SPARK_H - (PRACTICAL_FULL / maxVal) * SPARK_H;   // y of the 2-block line
  const inOverflow = maxVal > PRACTICAL_FULL;

  // Shading above the 2-block line while this node holds more than 2 blocks.
  if (inOverflow && networkFullY > 1) {
    parts.push(`<rect x="0" y="0" width="${SPARK_W}" height="${networkFullY.toFixed(1)}" fill="#7f1d1d" opacity="0.18"/>`);
  }

  // Coloured axis strip down the left edge (0-2 block band only).
  const STRIP_W = 8;
  parts.push(`<rect x="0" y="${networkFullY.toFixed(1)}" width="${STRIP_W}" height="${(SPARK_H - networkFullY).toFixed(1)}" fill="url(#mp-axis)" rx="1"/>`);

  // Half-block guidelines within the 0-2 block band. Drawn with explicit
  // visible strokes (the CSS grid class is near-invisible) and consistent label
  // offsets. The 1-block line is drawn later, on top of the fill. /*mp-grid-visible*/
  const gridStroke = 'rgba(160,180,210,0.28)';
  for (const f of [0.25, 0.75]) {
    const y = SPARK_H - f * (PRACTICAL_FULL / maxVal) * SPARK_H;
    parts.push(`<line x1="${STRIP_W + 2}" y1="${y.toFixed(1)}" x2="${SPARK_W}" y2="${y.toFixed(1)}" stroke="${gridStroke}" stroke-width="1" stroke-dasharray="5 5"/>`);
    parts.push(`<text x="${STRIP_W + 5}" y="${(y - 5).toFixed(1)}" style="fill:#9db0cc;font-size:13px;font-weight:600;font-family:ui-monospace,monospace;opacity:.85">${fmtBlk(f * DEFAULT_MEMPOOL_BLOCKS)}</text>`);
  }
  // The 2-block line (solid red), the network-wide threshold, kept prominent.
  parts.push(`<line x1="${STRIP_W + 2}" y1="${Math.max(1, networkFullY).toFixed(1)}" x2="${SPARK_W}" y2="${Math.max(1, networkFullY).toFixed(1)}" stroke="#ef4444" stroke-width="1.5" opacity="0.85"/>`);
  // Label below the line when it's at the top of the axis; above it while the
  // axis is extended, so it clears the compressed 1.5-block label.
  const fullLblY = inOverflow && networkFullY - 5 >= 34 ? networkFullY - 5 : Math.max(16, networkFullY + 16);
  parts.push(`<text x="${STRIP_W + 5}" y="${fullLblY.toFixed(1)}" style="fill:#ef4444;font-size:15px;font-weight:800;font-family:ui-monospace,monospace;opacity:.95">2 blocks: default mempools full</text>`);
  // Top-of-axis label while the axis is extended above 2 blocks.
  if (inOverflow) {
    parts.push(`<text x="${STRIP_W + 5}" y="16" style="fill:#fca5a5;font-size:13px;font-weight:600;font-family:ui-monospace,monospace;opacity:.9">${fmtBlk(maxVal / MAX_BLOCK_BODY)}</text>`);
  }

  // Block-boundary markers
  for (const x of markers) {
    parts.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${SPARK_H}" class="pt-mp-block-marker"/>`);
  }

  // Filled area
  if (fill) parts.push(`<path d="${fill}" fill="url(#mp-grad)" stroke="none"/>`);
  // Sharp line on top
  if (line) parts.push(`<path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.5"/>`);

  // The 1-block line (half of the 0-2 block axis). Drawn ON TOP of the fill
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
// Stored in BLOCKS queued: { unit: 'blocks', allTime: { blk, t }, mins: { <minute>: blk } }.
// Before item 18 this key held % of 2 blocks ({ allTime: { pct, t }, mins }),
// despite an old comment calling it fill-% of real capacity. peaksToBlocks()
// converts that once (value × 2 / 100); `unit: 'blocks'` is the done-marker,
// written in the same localStorage value as the converted peaks so a failed
// write can never convert twice. /*mp-peaks-blocks-v1*/
const PEAKS_KEY = 'pt.mempool.peaks.v2';
const MAX_PEAK_BLK = 20;   // clamp: a transient spike can't store an absurd value
let peaks = null;
let peaksLoaded = false;
let lastPeakSave = 0;

/**
 * Normalise a stored peaks object to blocks. Returns { peaks, converted }.
 * Already-converted input (unit 'blocks') passes through unchanged.
 */
export function peaksToBlocks(p) {
  const out = { unit: 'blocks', allTime: { blk: 0, t: 0 }, mins: {} };
  if (!p || typeof p !== 'object') return { peaks: out, converted: false };
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  if (p.unit === 'blocks') {
    if (p.allTime && num(p.allTime.blk) != null) out.allTime = { blk: p.allTime.blk, t: p.allTime.t || 0 };
    if (p.mins && typeof p.mins === 'object') {
      for (const [k, v] of Object.entries(p.mins)) if (num(v) != null) out.mins[k] = v;
    }
    return { peaks: out, converted: false };
  }
  const toBlk = (pct) => Math.min(MAX_PEAK_BLK, (pct * DEFAULT_MEMPOOL_BLOCKS) / 100);
  if (p.allTime && num(p.allTime.pct) != null) out.allTime = { blk: toBlk(p.allTime.pct), t: p.allTime.t || 0 };
  if (p.mins && typeof p.mins === 'object') {
    for (const [k, v] of Object.entries(p.mins)) if (num(v) != null) out.mins[k] = toBlk(v);
  }
  return { peaks: out, converted: true };
}

function loadPeaks() {
  if (peaksLoaded) return;
  peaksLoaded = true;
  peaks = peaksToBlocks(null).peaks;
  try {
    const raw = localStorage.getItem(PEAKS_KEY);
    if (raw) {
      const r = peaksToBlocks(JSON.parse(raw));
      peaks = r.peaks;
      if (r.converted) {
        localStorage.setItem(PEAKS_KEY, JSON.stringify(peaks));
        console.log(`[mempool] stored peaks converted from % of 2 blocks to blocks (all-time ${fmtBlk(peaks.allTime.blk)})`);
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

function recordPeak(blk) {
  // Never let demo-mode's synthetic mempool pollute the persisted peaks
  // that carry into real connections. /*demo-peak-guard*/
  if (getMode() === 'demo') return;
  loadPeaks();
  if (!isFinite(blk) || blk <= 0) return;
  // A queue beyond 2 blocks is real, useful info (more than default mempools
  // hold). Keep it, but clamp so a transient spike can't store an absurd value.
  if (blk > MAX_PEAK_BLK) blk = MAX_PEAK_BLK;   /*mp-peak-clamp*/
  const now = Date.now();
  let changed = false;
  if (blk > (peaks.allTime.blk || 0)) { peaks.allTime = { blk, t: now }; changed = true; }
  const m = Math.floor(now / 60000);
  if (blk > (peaks.mins[m] || 0)) { peaks.mins[m] = blk; changed = true; }
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
  byId('mp-stat-peak').textContent       = history.length ? fmtBlk(peak / MAX_BLOCK_BODY) : '—';
  const fmtP = v => v > 0 ? fmtBlk(v) : '\u2014';
  const e5 = byId('mp-peak-5m'); if (e5) e5.textContent = fmtP(maxOverMins(5 * 60000));
  const e1 = byId('mp-peak-1h'); if (e1) e1.textContent = fmtP(maxOverMins(60 * 60000));
  const e24 = byId('mp-peak-24h'); if (e24) e24.textContent = fmtP(maxOverMins(24 * 3600 * 1000));
  const ea = byId('mp-peak-all');
  const ath = peaks ? (peaks.allTime.blk || 0) : 0;
  const athT = peaks && ath > 0 ? peaks.allTime.t : 0;
  if (ea) { ea.textContent = fmtP(ath); ea.title = athT ? 'reached ' + new Date(athT).toLocaleString() : ''; }
  // The all-time peak's date, shown inline under it (not only on hover).
  const ed = byId('mp-peak-all-date');
  if (ed) ed.textContent = athT ? fmtPeakDate(athT) : '';
}

/** "7 Sep 13:27" (this year) or "7 Sep 2025". */
function fmtPeakDate(t) {
  const d = new Date(t);
  const day = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  if (d.getFullYear() !== new Date().getFullYear()) return `${day} ${d.getFullYear()}`;
  return `${day} ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

function ensureBody() {
  const body = byId('mp-body');
  if (!body) return;
  if (body.dataset.spark === '1') return;
  body.dataset.spark = '1';
  // Only the chart lives here now. The NET/THROUGHPUT/AVG/PEAK and MAX (blocks) stats
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
 *    MempoolCapacityBytesOverride). THIS node rejects txs only at that ceiling.
 *  - Most pools run the default, so at 2 blocks queued most of the network is
 *    full and may reject new txs. That is the headline: blocks queued,
 *    coloured by blkLevel().
 *  - This node's own fill (bytes / capacityInBytes) is the secondary line;
 *    "—" when the node didn't report its capacity (never a default).
 */
export function renderMempool(mp, opts = {}) {
  const countEl = byId('mp-count');
  if (!countEl) return;

  // Query failed (null): say so, and touch nothing that would record a reading -
  // no history sample, no sparkline point, no congestion state for the alerts
  // engine. /*mp-unavailable-v1*/
  if (!mp) {
    _lastMpState = null;
    countEl.innerHTML = '<span class="pt-mp-stats" data-unavailable="1">unavailable</span>';
    return;
  }

  //   blocks queued = bytes / maxBlockBodySize (one block clears ~88 KB)
  //   congestionPct = blocks vs the 2-block default, in %. Kept ONLY for the
  //                   alerts engine, whose stored threshold is in these units.
  //   capFillPct    = fill of this node's real capacity; null if unknown.
  const blocks = mp.totalBytes / MAX_BLOCK_BODY;
  const congestionPct = (mp.totalBytes / PRACTICAL_FULL) * 100;
  const cap = mp.capacityBytes > 0 ? mp.capacityBytes : null;
  const capFillPct = cap ? (mp.totalBytes / cap) * 100 : null;
  _lastMpState = { congestionPct, blocks, capFillPct };   // expose for alerts engine /*mp-alert-state*/

  // The MAX (blocks) column tracks blocks-queued peaks.
  recordPeak(blocks);

  // Emit stats as data attributes; the visible stat line is rendered on the
  // MEMPOOL bar header (now2.js) to avoid a redundant top row. /*mp-inline-stats*/
  countEl.innerHTML = `
    <span class="pt-mp-stats" data-txs="${mp.txCount}" data-bytes="${mp.totalBytes}" data-blocks="${blocks.toFixed(2)}" data-capfill="${fmtCapFill(mp.totalBytes, cap)}"></span>`;

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
