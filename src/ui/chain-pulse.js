/**
 * PoolTerminal — Chain Pulse panel (NOW view centrepiece).
 *
 * Three parts:
 *  1. "Since last block" big readout (neutral colour — NEVER red; Praos rule)
 *     + avg/max/min over the window.
 *  2. Heartbeat strip — network block arrivals over the last 5 min, scrolling
 *     left in real time via requestAnimationFrame. Irregular by nature (Praos).
 *  3. Density row — blocks/slots over 5m/1h/24h/7d/epoch, ~5% healthy.
 *
 * The only red/amber/green health signal here is the AT TIP badge in the header.
 *
 * Colours come from CSS variables, so SVG stroke is set via .style (presentation
 * attributes don't resolve var()). Geometry is set via attributes.
 */

import { commas, duration } from './format.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const W = 600;      // viewBox width (time axis; stretched to container)
const H = 56;
const WINDOW = 300; // 5 minutes

let ticks = [];     // [{ el, time }]
let rafId = null;
let lastData = null;

function byId(id) {
  return document.getElementById(id);
}
function setText(id, v) {
  const el = byId(id);
  if (el) el.textContent = v;
}

function makeLine(y1, colorVar, width) {
  const ln = document.createElementNS(SVGNS, 'line');
  ln.setAttribute('y1', y1);
  ln.setAttribute('y2', 42);
  ln.setAttribute('stroke-width', width);
  ln.setAttribute('vector-effect', 'non-scaling-stroke');
  ln.style.stroke = colorVar;
  return ln;
}

export function renderChainPulse(pulse) {
  lastData = pulse;

  const at = byId('cp-attip');
  if (at) {
    at.innerHTML = pulse.atTip
      ? '<span class="pt-dot pt-dot-good"></span><span style="color:var(--pt-status-good)">AT TIP</span>'
      : '<span class="pt-dot pt-dot-warn"></span><span style="color:var(--pt-status-warn)">BEHIND</span>';
  }
  setText('cp-tipblock', commas(pulse.tipBlock));
  setText('cp-avg', pulse.windowStats.avgSeconds + 's');
  setText('cp-max', pulse.windowStats.maxSeconds + 's');
  setText('cp-min', pulse.windowStats.minSeconds + 's');
  setText('cp-blockcount', pulse.recentBlockTimes.length + ' blocks');
  renderDensity(pulse.density);
  rebuildTicks(pulse.recentBlockTimes);

  if (!rafId) loop();
}

function renderDensity(d) {
  [
    ['cp-d-m5', d.m5], ['cp-d-h1', d.h1], ['cp-d-h24', d.h24],
    ['cp-d-d7', d.d7], ['cp-d-epoch', d.epoch],
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

function rebuildTicks(times) {
  const svg = byId('cp-heartbeat');
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  ticks = [];

  const base = makeLine(42, 'var(--pt-border)', 1);
  base.setAttribute('x1', 0);
  base.setAttribute('x2', W);
  svg.appendChild(base);

  times.forEach((t, i) => {
    const latest = i === times.length - 1;
    const ln = makeLine(
      latest ? 8 : 14,
      latest ? 'var(--pt-accent-blue-bright)' : 'var(--pt-accent-blue)',
      latest ? 2 : 1.5
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
    const x = (W * (1 - age / WINDOW)).toFixed(1);
    t.el.setAttribute('x1', x);
    t.el.setAttribute('x2', x);
    t.el.style.display = age < 0 || age > WINDOW ? 'none' : '';
  }
}

export function stopChainPulse() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  ticks = [];
  lastData = null;
}
