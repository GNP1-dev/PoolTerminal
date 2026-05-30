/**
 * PoolTerminal — Chain Pulse panel.
 *
 * Strip-chart ECG mode:
 *   • 10s / 30s / 1m views: full QRS-T complex (P wave, PR, Q dip, R spike,
 *     S dip, ST flat, small gentle T wave via Bezier — T wave is half as
 *     long and half as high as the original).
 *   • 5m view: QRS-only complex (Q dip, R spike, S dip, recovery), centered
 *     in a 20-unit-wide complex. The QRS shape itself is identical to the
 *     QRS section of the 1m view; the P wave and T wave are stripped.
 *   • Tick mode for 15m / 1h: vertical blue lines (unchanged).
 *
 * History preservation: rebuildHeartbeat plants historical complexes from
 * lastData.recentBlockTimes (visible subset) on every rebuild — init, tab
 * switch, bootstrap. Switching tabs no longer wipes the visualization.
 *
 * Timescale: horizontal ruler at the bottom of every view, ticks + labels
 * (now, -10s, -20s, …) sized to the current window.
 *
 * Path tail (PATH_TAIL viewBox units past xR) at baseline level overlaps
 * the resumed baseline — forced visual handshake to bridge any perceived
 * gap between trace end and baseline start.
 */

import { commas, duration } from './format.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const W = 600;
const H = 120;

const BASELINE_Y = 70;
const R_HEIGHT   = 55;
const Q_DEPTH    = 5;
const S_DEPTH    = 18;
const P_HEIGHT   = 8;
const T_HEIGHT   = 7;      // half of previous (14)
const ECG_STROKE = '#ff3344';
const DRAW_DURATION_S = 0.5;
const PATH_TAIL = 6;

const TICK_BASELINE_Y  = 92;
const TICK_LATEST_TOP  = 22;
const TICK_NORMAL_TOP  = 40;
const TICK_NOWMARK_TOP = 8;
const TICK_NOWMARK_BOT = 96;

const TIMESCALE_Y_TOP = 102;
const TIMESCALE_Y_BOT = 105;
const TIMESCALE_LABEL_Y = 115;

let ticks = [];
let baselineSegments = [];
let complexGroup = null;
let activeComplexes = [];
let rafId = null;
let lastData = null;
let currentWindow = 60;
let optimisticTimes = [];
let densityFrameCounter = 0;

const TICK_DEDUP_TOLERANCE_S = 10;

function byId(id) { return document.getElementById(id); }
function setText(id, v) { const el = byId(id); if (el) el.textContent = v; }

function getComplexWidth() {
  if (currentWindow <= 10) return 70;
  if (currentWindow <= 30) return 55;
  if (currentWindow <= 60) return 42;
  return 20;    // 5m: QRS-only complex, narrow with QRS centred
}

function makeLine(y1, y2, color, width) {
  const ln = document.createElementNS(SVGNS, 'line');
  ln.setAttribute('y1', y1);
  ln.setAttribute('y2', y2);
  ln.setAttribute('stroke-width', width);
  ln.setAttribute('vector-effect', 'non-scaling-stroke');
  ln.style.stroke = color;
  return ln;
}

function makeBaselineLine() {
  return makeLine(BASELINE_Y, BASELINE_Y, ECG_STROKE, 1.6);
}

function clearComplexes() {
  for (const c of activeComplexes) {
    if (c.el && c.el.parentNode) c.el.parentNode.removeChild(c.el);
  }
  activeComplexes = [];
}

function ensureTabsWired() {
  const container = byId('cp-tabs');
  if (!container || container._wired) return;
  container.addEventListener('click', (e) => {
    const tab = e.target.closest('.pt-cp-tab');
    if (!tab) return;
    currentWindow = Number(tab.dataset.window);
    paintActiveTab();
    clearComplexes();
    if (lastData) rebuildHeartbeat(lastData.recentBlockTimes);
  });
  container._wired = true;
}

function paintActiveTab() {
  const container = byId('cp-tabs');
  if (!container) return;
  container.querySelectorAll('.pt-cp-tab').forEach((t) => {
    t.classList.toggle('pt-cp-tab-active', Number(t.dataset.window) === currentWindow);
  });
}

function renderDensity(d) {
  [
    ['cp-d-m1', d.m1], ['cp-d-m5', d.m5], ['cp-d-m20', d.m20],
    ['cp-d-h1', d.h1], ['cp-d-d1', d.d1], ['cp-d-epoch', d.epoch],
  ].forEach(([id, frac]) => {
    const el = byId(id);
    if (!el) return;
    const p = frac * 100;
    el.textContent = p.toFixed(1) + '%';
    const dist = Math.abs(p - 5);
    el.style.color =
      dist <= 0.5 ? 'var(--pt-status-good)'
      : dist <= 1.5 ? 'var(--pt-status-warn)'
      : 'var(--pt-status-bad)';
  });
}

function recomputeDensity() {
  if (!lastData) return;
  const now = Date.now() / 1000;
  const ageCutoff = now - 3700;
  lastData.recentBlockTimes = lastData.recentBlockTimes.filter((t) => t > ageCutoff);
  const times = lastData.recentBlockTimes;
  const countWithin = (w) => times.filter((t) => now - t <= w).length;
  lastData.density = {
    m1:  countWithin(60)   / 60,
    m5:  countWithin(300)  / 300,
    m20: countWithin(1200) / 1200,
    h1:  countWithin(3600) / 3600,
    d1:  0.05,
    epoch: 0.05,
  };
  renderDensity(lastData.density);
}

function recomputeStats() {
  if (!lastData) return;
  const now = Date.now() / 1000;

  // AVG/MAX/MIN over the last hour for stable sample size
  const longTimes = lastData.recentBlockTimes.filter((t) => now - t <= 3600);
  const gaps = [];
  for (let i = 1; i < longTimes.length; i++) gaps.push(longTimes[i] - longTimes[i - 1]);
  const avg = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
  const max = gaps.length ? Math.max(...gaps) : 0;
  const min = gaps.length ? Math.min(...gaps) : 0;
  setText('cp-avg', avg + 's');
  setText('cp-max', max + 's');
  setText('cp-min', min + 's');

  // Block count reflects currently selected interval
  const windowTimes = lastData.recentBlockTimes.filter((t) => now - t <= currentWindow);
  setText('cp-blockcount', windowTimes.length + ' blocks');
}

// ════════════════════════════════════════════════════════════════════════
// ECG SCROLL MODE
// ════════════════════════════════════════════════════════════════════════

function buildComplexPath(cw) {
  const BL = BASELINE_Y;
  const xat = (p) => -cw * (1 - p);

  // 5m view: QRS-only complex with QRS centred at p=0.50.
  // Percentages chosen so PR_end→Q→R→S→recovery spans exactly 6 viewBox
  // units, identical absolute QRS width to the 1m view.
  if (currentWindow >= 300) {
    let d = `M ${xat(0).toFixed(1)},${BL}`;
    d += ` L ${xat(0.35).toFixed(1)},${BL}`;                       // lead-in flat
    d += ` L ${xat(0.425).toFixed(1)},${BL + Q_DEPTH}`;            // Q
    d += ` L ${xat(0.50).toFixed(1)},${BL - R_HEIGHT}`;            // R
    d += ` L ${xat(0.575).toFixed(1)},${BL + S_DEPTH}`;            // S
    d += ` L ${xat(0.65).toFixed(1)},${BL}`;                       // recovery
    d += ` L ${xat(1.00).toFixed(1)},${BL}`;                       // trailing flat
    d += ` L ${PATH_TAIL.toFixed(1)},${BL}`;                       // tail past xR
    return d;
  }

  // 10s / 30s / 1m: full QRS-T complex with smaller T wave.
  let d = `M ${xat(0).toFixed(1)},${BL}`;
  // P wave (Bezier)
  d += ` Q ${xat(0.08).toFixed(1)},${(BL - 2 * P_HEIGHT).toFixed(1)} ${xat(0.16).toFixed(1)},${BL}`;
  // PR flat
  d += ` L ${xat(0.24).toFixed(1)},${BL}`;
  // Q dip
  d += ` L ${xat(0.27).toFixed(1)},${BL + Q_DEPTH}`;
  // R spike
  d += ` L ${xat(0.30).toFixed(1)},${BL - R_HEIGHT}`;
  // S dip
  d += ` L ${xat(0.33).toFixed(1)},${BL + S_DEPTH}`;
  // Back to BL
  d += ` L ${xat(0.36).toFixed(1)},${BL}`;
  // ST flat (brief — T wave now starts right after QRS recovery)
  d += ` L ${xat(0.42).toFixed(1)},${BL}`;
  // T wave (Bezier, peak control at 0.60, ends at 0.78 — close to QRS)
  d += ` Q ${xat(0.60).toFixed(1)},${(BL - 2 * T_HEIGHT).toFixed(1)} ${xat(0.78).toFixed(1)},${BL}`;
  // Trailing flat
  d += ` L ${xat(1.00).toFixed(1)},${BL}`;
  // Tail past xR
  d += ` L ${PATH_TAIL.toFixed(1)},${BL}`;
  return d;
}

function buildComplexElement(cw) {
  const el = document.createElementNS(SVGNS, 'path');
  el.setAttribute('d', buildComplexPath(cw));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', ECG_STROKE);
  el.setAttribute('stroke-width', '1.6');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('vector-effect', 'non-scaling-stroke');
  el.setAttribute('filter', 'url(#ecg-glow)');
  return el;
}

function plantComplex(eventTime) {
  if (!complexGroup) return;

  const cw = getComplexWidth();
  const el = buildComplexElement(cw);
  el.setAttribute('transform', `translate(${W}, 0)`);
  complexGroup.appendChild(el);

  const len = el.getTotalLength();
  el.style.strokeDasharray = `${len}`;
  el.style.strokeDashoffset = `${len}`;
  el.style.transition = 'none';
  el.getBoundingClientRect();

  el.style.transition = `stroke-dashoffset ${DRAW_DURATION_S}s linear`;
  el.style.strokeDashoffset = '0';

  setTimeout(() => {
    el.style.transition = 'none';
    el.style.strokeDasharray = 'none';
    el.style.strokeDashoffset = '0';
  }, DRAW_DURATION_S * 1000 + 60);

  activeComplexes.push({ el, eventTime, complexWidth: cw });
  updateBaseline();
}

function plantHistoricalComplex(eventTime) {
  if (!complexGroup) return;

  const cw = getComplexWidth();
  const el = buildComplexElement(cw);

  const now = Date.now() / 1000;
  const pps = W / currentWindow;
  const x = W - (now - eventTime) * pps;
  el.setAttribute('transform', `translate(${x.toFixed(1)}, 0)`);
  complexGroup.appendChild(el);

  activeComplexes.push({ el, eventTime, complexWidth: cw });
}

function setupECGMode(svg) {
  const defs = document.createElementNS(SVGNS, 'defs');
  const filter = document.createElementNS(SVGNS, 'filter');
  filter.setAttribute('id', 'ecg-glow');
  filter.setAttribute('x', '-20%');
  filter.setAttribute('y', '-20%');
  filter.setAttribute('width', '140%');
  filter.setAttribute('height', '140%');
  const blur = document.createElementNS(SVGNS, 'feGaussianBlur');
  blur.setAttribute('stdDeviation', '2.2');
  blur.setAttribute('result', 'blur');
  filter.appendChild(blur);
  const merge = document.createElementNS(SVGNS, 'feMerge');
  const m1 = document.createElementNS(SVGNS, 'feMergeNode');
  m1.setAttribute('in', 'blur');
  merge.appendChild(m1);
  const m2 = document.createElementNS(SVGNS, 'feMergeNode');
  m2.setAttribute('in', 'SourceGraphic');
  merge.appendChild(m2);
  filter.appendChild(merge);
  defs.appendChild(filter);
  svg.appendChild(defs);

  baselineSegments = [];
  const seg = makeBaselineLine();
  seg.setAttribute('x1', 0);
  seg.setAttribute('x2', W);
  svg.appendChild(seg);
  baselineSegments.push(seg);

  complexGroup = document.createElementNS(SVGNS, 'g');
  svg.appendChild(complexGroup);
}

function updateBaseline() {
  if (baselineSegments.length === 0) return;
  const parent = baselineSegments[0].parentNode;
  if (!parent) return;

  const now = Date.now() / 1000;
  const pps = W / currentWindow;

  const ranges = [];
  for (const c of activeComplexes) {
    const xR = W - (now - c.eventTime) * pps;
    const xL = xR - c.complexWidth;
    if (xR <= 0 || xL >= W) continue;
    ranges.push({
      left:  Math.max(0, xL),
      right: Math.min(W, xR),
    });
  }

  ranges.sort((a, b) => a.left - b.left);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && last.right >= r.left) {
      last.right = Math.max(last.right, r.right);
    } else {
      merged.push({ left: r.left, right: r.right });
    }
  }

  const segs = [];
  let cursor = 0;
  for (const r of merged) {
    if (r.left > cursor) {
      segs.push({ x1: cursor, x2: r.left });
    }
    cursor = r.right;
  }
  if (cursor < W) {
    segs.push({ x1: cursor, x2: W });
  }

  while (baselineSegments.length < segs.length) {
    const ln = makeBaselineLine();
    if (complexGroup && complexGroup.parentNode === parent) {
      parent.insertBefore(ln, complexGroup);
    } else {
      parent.appendChild(ln);
    }
    baselineSegments.push(ln);
  }

  segs.forEach((s, i) => {
    const ln = baselineSegments[i];
    ln.setAttribute('x1', s.x1.toFixed(1));
    ln.setAttribute('x2', s.x2.toFixed(1));
    ln.style.display = '';
  });
  for (let i = segs.length; i < baselineSegments.length; i++) {
    baselineSegments[i].style.display = 'none';
  }
}

function animateECG() {
  if (!complexGroup) return;
  const now = Date.now() / 1000;
  const pps = W / currentWindow;

  for (let i = activeComplexes.length - 1; i >= 0; i--) {
    const c = activeComplexes[i];
    const dt = now - c.eventTime;
    const x = W - dt * pps;

    if (x < -10) {
      if (c.el && c.el.parentNode) c.el.parentNode.removeChild(c.el);
      activeComplexes.splice(i, 1);
      continue;
    }
    c.el.setAttribute('transform', `translate(${x.toFixed(1)}, 0)`);
  }

  updateBaseline();
}

// ════════════════════════════════════════════════════════════════════════
// TICK MODE (15m / 1h)
// ════════════════════════════════════════════════════════════════════════

function setupTickMode(svg, allTimes) {
  const now = Date.now() / 1000;
  const visible = allTimes.filter((t) => now - t <= currentWindow);

  const base = makeLine(TICK_BASELINE_Y, TICK_BASELINE_Y, 'var(--pt-border)', 1);
  base.setAttribute('x1', 0);
  base.setAttribute('x2', W);
  svg.appendChild(base);

  visible.forEach((t, i) => {
    const latest = i === visible.length - 1;
    const ln = makeLine(
      latest ? TICK_LATEST_TOP : TICK_NORMAL_TOP,
      TICK_BASELINE_Y,
      ECG_STROKE,
      latest ? 2 : 1
    );
    if (!latest) ln.style.opacity = '0.7';
    svg.appendChild(ln);
    ticks.push({ el: ln, time: t });
  });

  const nowm = makeLine(TICK_NOWMARK_TOP, TICK_NOWMARK_BOT, 'var(--pt-status-good)', 1);
  nowm.setAttribute('x1', W - 1);
  nowm.setAttribute('x2', W - 1);
  nowm.setAttribute('stroke-dasharray', '2 2');
  nowm.setAttribute('opacity', '0.5');
  svg.appendChild(nowm);
}

function animateTicks() {
  const now = Date.now() / 1000;
  for (const t of ticks) {
    const age = now - t.time;
    const drawAge = Math.max(0, age);
    const x = (W * (1 - drawAge / currentWindow)).toFixed(1);
    t.el.setAttribute('x1', x);
    t.el.setAttribute('x2', x);
    t.el.style.display = age > currentWindow ? 'none' : '';
  }
}

// ════════════════════════════════════════════════════════════════════════
// TIMESCALE
// ════════════════════════════════════════════════════════════════════════

function getTimescaleInterval() {
  switch (currentWindow) {
    case 10:   return 2;
    case 30:   return 5;
    case 60:   return 10;
    case 300:  return 60;
    case 900:  return 180;
    case 3600: return 600;
    default:   return Math.max(1, Math.round(currentWindow / 6));
  }
}

function formatTimeAgoLabel(secs) {
  if (secs === 0) return 'now';
  if (secs < 60) return `-${secs}s`;
  if (secs < 3600) return `-${Math.floor(secs / 60)}m`;
  return `-${Math.floor(secs / 3600)}h`;
}

function setupTimescale(svg) {
  const tsGroup = document.createElementNS(SVGNS, 'g');
  tsGroup.setAttribute('id', 'cp-timescale');

  const interval = getTimescaleInterval();
  for (let timeAgo = 0; timeAgo <= currentWindow; timeAgo += interval) {
    const x = W * (1 - timeAgo / currentWindow);

    const mark = document.createElementNS(SVGNS, 'line');
    mark.setAttribute('x1', x.toFixed(1));
    mark.setAttribute('y1', TIMESCALE_Y_TOP);
    mark.setAttribute('x2', x.toFixed(1));
    mark.setAttribute('y2', TIMESCALE_Y_BOT);
    mark.setAttribute('stroke-width', '0.5');
    mark.setAttribute('vector-effect', 'non-scaling-stroke');
    mark.style.stroke = 'var(--pt-muted, #6a6a6a)';
    mark.style.opacity = '0.7';
    tsGroup.appendChild(mark);

    let anchor = 'middle';
    if (timeAgo === 0) anchor = 'end';
    else if (timeAgo === currentWindow) anchor = 'start';

    const text = document.createElementNS(SVGNS, 'text');
    text.setAttribute('x', x.toFixed(1));
    text.setAttribute('y', TIMESCALE_LABEL_Y);
    text.setAttribute('text-anchor', anchor);
    text.setAttribute('font-size', '8');
    text.setAttribute('font-family', 'ui-monospace, monospace');
    text.style.fill = 'var(--pt-muted, #6a6a6a)';
    text.style.opacity = '0.85';
    text.textContent = formatTimeAgoLabel(timeAgo);
    tsGroup.appendChild(text);
  }

  svg.appendChild(tsGroup);
}

// ════════════════════════════════════════════════════════════════════════
// MODE DISPATCH
// ════════════════════════════════════════════════════════════════════════

function rebuildHeartbeat(allTimes) {
  const svg = byId('cp-heartbeat');
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  ticks = [];
  baselineSegments = [];
  complexGroup = null;
  activeComplexes = [];

  if (currentWindow <= 300) {
    setupECGMode(svg);
    const now = Date.now() / 1000;
    const visible = (allTimes || [])
      .filter((t) => {
        const dt = now - t;
        return dt >= 0 && dt <= currentWindow;
      })
      .sort((a, b) => a - b);
    for (const t of visible) plantHistoricalComplex(t);
    updateBaseline();
  } else {
    setupTickMode(svg, allTimes || []);
  }

  setupTimescale(svg);
  recomputeStats();
}

export function initChainPulse() {
  if (!lastData) {
    const cutoff = Date.now() / 1000 - 3700;
    optimisticTimes = optimisticTimes.filter((t) => t > cutoff);
    lastData = {
      atTip: false,
      tipBlock: 0,
      recentBlockTimes: [...optimisticTimes].sort((a, b) => a - b),
      density: { m1: 0, m5: 0, m20: 0, h1: 0, d1: 0.05, epoch: 0.05 },
    };
  }
  ensureTabsWired();
  paintActiveTab();
  renderDensity(lastData.density);
  rebuildHeartbeat(lastData.recentBlockTimes);
  if (!rafId) loop();
}

export function setChainPulseStatus(atTip, tipBlock) {
  if (lastData) {
    lastData.atTip = atTip;
    lastData.tipBlock = tipBlock;
  }
  const at = byId('cp-attip');
  if (at) {
    at.innerHTML = atTip
      ? '<span class="pt-dot pt-dot-good"></span><span style="color:var(--pt-status-good)">AT TIP</span>'
      : '<span class="pt-dot pt-dot-warn"></span><span style="color:var(--pt-status-warn)">BEHIND</span>';
  }
  setText('cp-tipblock', commas(tipBlock));
}

export function appendTick(timeSec) {
  const cutoff = Date.now() / 1000 - 3700;
  optimisticTimes = optimisticTimes.filter((t) => t > cutoff);
  optimisticTimes.push(timeSec);

  if (!lastData) return;

  lastData.recentBlockTimes.push(timeSec);
  lastData.recentBlockTimes.sort((a, b) => a - b);

  const svg = byId('cp-heartbeat');
  if (svg) {
    if (currentWindow <= 300) {
      plantComplex(Date.now() / 1000);
    } else {
      if (ticks.length > 0) {
        const prev = ticks[ticks.length - 1];
        prev.el.setAttribute('y1', TICK_NORMAL_TOP);
        prev.el.setAttribute('stroke-width', 1);
        prev.el.style.stroke = ECG_STROKE;
        prev.el.style.opacity = '0.7';
      }
      const ln = makeLine(TICK_LATEST_TOP, TICK_BASELINE_Y, ECG_STROKE, 2);
      ln.setAttribute('x1', W);
      ln.setAttribute('x2', W);
      svg.appendChild(ln);
      ticks.push({ el: ln, time: timeSec });
    }
  }

  recomputeStats();
  recomputeDensity();
}

export function renderChainPulse(pulse) {
  const cutoff = Date.now() / 1000 - 3700;
  optimisticTimes = optimisticTimes.filter((t) => t > cutoff);

  if (pulse.recentBlockTimes && pulse.recentBlockTimes.length) {
    optimisticTimes = optimisticTimes.filter(
      (opt) => !pulse.recentBlockTimes.some((c) => Math.abs(c - opt) < TICK_DEDUP_TOLERANCE_S)
    );
  }

  const all = [...(pulse.recentBlockTimes || []), ...optimisticTimes];
  const seen = new Set();
  const merged = all.filter((t) => {
    const key = Math.floor(t / 5);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  merged.sort((a, b) => a - b);

  lastData = {
    atTip: pulse.atTip,
    tipBlock: pulse.tipBlock,
    recentBlockTimes: merged,
    density: pulse.density,
  };
  ensureTabsWired();
  paintActiveTab();

  const at = byId('cp-attip');
  if (at) {
    at.innerHTML = pulse.atTip
      ? '<span class="pt-dot pt-dot-good"></span><span style="color:var(--pt-status-good)">AT TIP</span>'
      : '<span class="pt-dot pt-dot-warn"></span><span style="color:var(--pt-status-warn)">BEHIND</span>';
  }
  setText('cp-tipblock', commas(pulse.tipBlock));

  rebuildHeartbeat(merged);
  recomputeDensity();

  if (!rafId) loop();
}

function loop() {
  rafId = requestAnimationFrame(loop);
  if (!lastData) return;
  const now = Date.now() / 1000;

  const times = lastData.recentBlockTimes;
  const latest = times.length ? times[times.length - 1] : now;
  setText('cp-since', duration(Math.max(0, Math.floor(now - latest))));

  if (currentWindow <= 300) {
    animateECG();
  } else {
    animateTicks();
  }

  densityFrameCounter++;
  if (densityFrameCounter >= 60) {
    densityFrameCounter = 0;
    recomputeDensity();
    recomputeStats();
  }
}

export function stopChainPulse() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  ticks = [];
  baselineSegments = [];
  complexGroup = null;
  activeComplexes = [];
}
