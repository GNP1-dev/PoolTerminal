/**
 * PoolTerminal — Chain Pulse panel.
 *
 * Two rendering entry points:
 *   renderChainPulse(pulse)  — one-time bootstrap (cncli historical data).
 *                              Merges in any optimistic ticks already collected.
 *   appendTick(timeSec)      — fast loop on tip-block change. Adds a single
 *                              bright tick for instant feedback (~1s after the
 *                              block lands, matching gLiveView).
 *
 * Density is computed client-side from the current tick set, recomputed on
 * every appendTick and periodically in the rAF loop so windows drift correctly
 * as blocks age out.
 *
 * Module-level state is preserved across mount/unmount (tab switches) so
 * accumulated history doesn't reset. Only the SVG DOM and tick refs need
 * rebuilding on remount.
 */

import { commas, duration } from './format.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const W = 600;
const H = 56;

let ticks = [];
let rafId = null;
let lastData = null;
let currentWindow = 300;
let optimisticTimes = [];
let densityFrameCounter = 0;

// Optimistic ticks within this many seconds of any cncli tick (during bootstrap
// merge) are deduped. Optimistic time uses browser-now; cncli uses slotToUnix.
const TICK_DEDUP_TOLERANCE_S = 10;

function byId(id) { return document.getElementById(id); }
function setText(id, v) { const el = byId(id); if (el) el.textContent = v; }

function makeLine(y1, colorVar, width) {
  const ln = document.createElementNS(SVGNS, 'line');
  ln.setAttribute('y1', y1);
  ln.setAttribute('y2', 42);
  ln.setAttribute('stroke-width', width);
  ln.setAttribute('vector-effect', 'non-scaling-stroke');
  ln.style.stroke = colorVar;
  return ln;
}

function ensureTabsWired() {
  const container = byId('cp-tabs');
  if (!container || container._wired) return;
  container.addEventListener('click', (e) => {
    const tab = e.target.closest('.pt-cp-tab');
    if (!tab) return;
    currentWindow = Number(tab.dataset.window);
    paintActiveTab();
    if (lastData) rebuildTicks(lastData.recentBlockTimes);
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
  // Prune block times older than 1h (out of any window).
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
  const times = lastData.recentBlockTimes.filter((t) => now - t <= currentWindow);
  const gaps = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
  const avg = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
  const max = gaps.length ? Math.max(...gaps) : 0;
  const min = gaps.length ? Math.min(...gaps) : 0;
  setText('cp-avg', avg + 's');
  setText('cp-max', max + 's');
  setText('cp-min', min + 's');
  setText('cp-blockcount', times.length + ' blocks');
}

export function initChainPulse() {
  if (!lastData) {
    // First-time init OR remount after long absence: seed with any accumulated
    // optimistic ticks (block detections during a tab switch, etc.).
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
  rebuildTicks(lastData.recentBlockTimes);
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
  // Track optimistic time even if panel isn't mounted (preserved across mount/unmount).
  const cutoff = Date.now() / 1000 - 3700;
  optimisticTimes = optimisticTimes.filter((t) => t > cutoff);
  optimisticTimes.push(timeSec);

  if (!lastData) {
    // Panel not yet initialized — just track the time, will be picked up on next init.
    return;
  }

  // Insert into recentBlockTimes (maintain sorted order).
  lastData.recentBlockTimes.push(timeSec);
  lastData.recentBlockTimes.sort((a, b) => a - b);

  const svg = byId('cp-heartbeat');
  if (!svg) return;

  // Demote previous "latest" tick (was bright/tall) to normal.
  if (ticks.length > 0) {
    const prev = ticks[ticks.length - 1];
    prev.el.setAttribute('y1', 14);
    prev.el.setAttribute('stroke-width', currentWindow <= 300 ? 1.5 : 1);
    prev.el.style.stroke = 'var(--pt-accent-blue)';
  }

  // Add new latest tick at right edge.
  const now = Date.now() / 1000;
  const age = Math.max(0, now - timeSec);
  const x = (W * (1 - age / currentWindow)).toFixed(1);
  const ln = makeLine(8, 'var(--pt-accent-blue-bright)', 2);
  ln.setAttribute('x1', x);
  ln.setAttribute('x2', x);
  svg.appendChild(ln);
  ticks.push({ el: ln, time: timeSec });

  recomputeStats();
  recomputeDensity();
}

export function renderChainPulse(pulse) {
  // Bootstrap path: merge cncli history with any optimistic ticks already collected.
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

  rebuildTicks(merged);
  recomputeDensity();

  if (!rafId) loop();
}

function rebuildTicks(allTimes) {
  const svg = byId('cp-heartbeat');
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  ticks = [];

  const now = Date.now() / 1000;
  const visible = allTimes.filter((t) => now - t <= currentWindow);

  const gaps = [];
  for (let i = 1; i < visible.length; i++) gaps.push(visible[i] - visible[i - 1]);
  const avg = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
  const max = gaps.length ? Math.max(...gaps) : 0;
  const min = gaps.length ? Math.min(...gaps) : 0;
  setText('cp-avg', avg + 's');
  setText('cp-max', max + 's');
  setText('cp-min', min + 's');
  setText('cp-blockcount', visible.length + ' blocks');

  const base = makeLine(42, 'var(--pt-border)', 1);
  base.setAttribute('x1', 0);
  base.setAttribute('x2', W);
  svg.appendChild(base);

  const thick = currentWindow <= 300 ? 1.5 : 1;
  visible.forEach((t, i) => {
    const latest = i === visible.length - 1;
    const ln = makeLine(
      latest ? 8 : 14,
      latest ? 'var(--pt-accent-blue-bright)' : 'var(--pt-accent-blue)',
      latest ? 2 : thick
    );
    svg.appendChild(ln);
    ticks.push({ el: ln, time: t });
  });

  const nowm = makeLine(2, 'var(--pt-status-good)', 1);
  nowm.setAttribute('x1', W - 1);
  nowm.setAttribute('x2', W - 1);
  nowm.setAttribute('y2', H);
  nowm.setAttribute('stroke-dasharray', '2 2');
  nowm.setAttribute('opacity', '0.7');
  svg.appendChild(nowm);
}

function loop() {
  rafId = requestAnimationFrame(loop);
  if (!lastData) return;
  const now = Date.now() / 1000;

  const times = lastData.recentBlockTimes;
  const latest = times.length ? times[times.length - 1] : now;
  setText('cp-since', duration(Math.max(0, Math.floor(now - latest))));

  for (const t of ticks) {
    const age = now - t.time;
    const drawAge = Math.max(0, age);
    const x = (W * (1 - drawAge / currentWindow)).toFixed(1);
    t.el.setAttribute('x1', x);
    t.el.setAttribute('x2', x);
    t.el.style.display = age > currentWindow ? 'none' : '';
  }

  // Recompute density + stats roughly every second (60 frames @ 60fps).
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
  // Keep lastData and optimisticTimes — they're preserved across mount/unmount.
}
