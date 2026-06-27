/**
 * PoolTerminal - NOW instrument gauges (car-dashboard redesign).
 *
 * Pure, self-contained rendering + update primitives for the NOW view's
 * instrument deck:
 *   - speedo  : realistic-needle arc gauge (shared scale fn so the needle
 *               physically points at the tick it reads), optional red zone.
 *   - thermo  : vertical thermometer (KES, Epoch - slow movers).
 *   - tanks   : chained equal block-capacity tanks for the mempool
 *               (fill -> spill into next tank -> drain on block mint).
 *
 * Design rules carried from the agreed mockup (now_refined.html):
 *   270 deg sweep starting at 135 deg; one ang() drives ticks AND needle.
 *
 * This module is presentation only. It does not fetch data and does not know
 * about the registry - callers pass already-resolved numbers. That keeps it
 * trivially testable and impossible to break the data layer with.
 */

const D2R = Math.PI / 180;
const START = 135;   // degrees, bottom-left
const SWEEP = 270;   // degrees of travel to bottom-right

function clamp01(x) { return Math.max(0, Math.min(1, x)); }
function ang(frac) { return START + SWEEP * clamp01(frac); }
function ptOnArc(cx, cy, r, frac) {
  const a = ang(frac) * D2R;
  return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
}
function arcD(cx, cy, r, f0, f1) {
  const [x0, y0] = ptOnArc(cx, cy, r, f0);
  const [x1, y1] = ptOnArc(cx, cy, r, f1);
  const large = (ang(f1) - ang(f0)) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/**
 * Build a speedometer SVG. Returns an HTML string.
 * opts: { id, min, max, ticks, major, color, redFrom (0..1 | null), label }
 * Element IDs created: `${id}-ndl` (needle group), `${id}-val` is supplied by
 * the caller's surrounding markup (kept separate so hero-* IDs can be reused).
 */
export function speedoSVG(opts) {
  const cx = 80, cy = 80, R = 58;
  const id = opts.id;
  const col = opts.color || '#36e0d4';
  const n = opts.ticks || 16;
  const major = opts.major || 4;
  let s = `<svg id="${id}" width="160" height="120" viewBox="0 0 160 120" class="pt-speedo">`;
  s += `<defs><filter id="${id}-glow" x="-50%" y="-50%" width="200%" height="200%">`
     + `<feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>`;
  // base track
  s += `<path d="${arcD(cx, cy, R, 0, 1)}" fill="none" stroke="rgba(120,150,200,.16)" stroke-width="8"/>`;
  // red zone
  if (opts.redFrom != null) {
    s += `<path d="${arcD(cx, cy, R, opts.redFrom, 1)}" fill="none" stroke="#ff3344" stroke-width="8" filter="url(#${id}-glow)"/>`;
  }
  // ticks + labels
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const isMaj = (i % (n / major)) === 0;
    const [x1, y1] = ptOnArc(cx, cy, R - 4, f);
    const [x2, y2] = ptOnArc(cx, cy, R - (isMaj ? 16 : 10), f);
    s += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#9fb0d0" stroke-width="${isMaj ? 2 : 1}" opacity="${isMaj ? 0.75 : 0.32}"/>`;
    if (isMaj && opts.min != null) {
      const [lx, ly] = ptOnArc(cx, cy, R - 27, f);
      const val = Math.round(opts.min + (opts.max - opts.min) * f);
      s += `<text x="${lx.toFixed(1)}" y="${(ly + 3).toFixed(1)}" text-anchor="middle" class="pt-speedo-tick">${val}</text>`;
    }
  }
  // needle (drawn pointing at min; rotated by paint). Tapered + counterweight + hub.
  const a = ang(0) * D2R, tipR = R - 12;
  const tipx = cx + Math.cos(a) * tipR, tipy = cy + Math.sin(a) * tipR;
  const pa = a + Math.PI / 2;
  const b1x = cx + Math.cos(pa) * 4, b1y = cy + Math.sin(pa) * 4;
  const b2x = cx - Math.cos(pa) * 4, b2y = cy - Math.sin(pa) * 4;
  const tailx = cx - Math.cos(a) * 12, taily = cy - Math.sin(a) * 12;
  s += `<g id="${id}-ndl" class="pt-needle" style="transform-origin:${cx}px ${cy}px">`;
  s += `<polygon points="${b1x.toFixed(1)},${b1y.toFixed(1)} ${tipx.toFixed(1)},${tipy.toFixed(1)} ${b2x.toFixed(1)},${b2y.toFixed(1)} ${tailx.toFixed(1)},${taily.toFixed(1)}" fill="${col}" filter="url(#${id}-glow)"/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="7" fill="#0a0f1c" stroke="${col}" stroke-width="2"/>`;
  s += `<circle cx="${cx}" cy="${cy}" r="2.5" fill="${col}"/></g>`;
  s += `</svg>`;
  return s;
}

/** Rotate a speedo needle to a value fraction (0..1). Animated via CSS. */
export function setSpeedo(root, id, frac) {
  const g = (root || document).querySelector('#' + id + '-ndl');
  if (!g) return;
  g.style.transform = `rotate(${(SWEEP * clamp01(frac)).toFixed(1)}deg)`;
}

/**
 * Build a vertical thermometer. Returns an HTML string.
 * opts: { id, color }. Creates `${id}-fill` (the column) to drive by height.
 */
export function thermoHTML(opts) {
  const id = opts.id, col = opts.color || '#ffc24a';
  const ticks = opts.ticks || [];
  let t = '';
  for (const tk of ticks) {
    t += `<div class="pt-thermo-tick" style="bottom:${(tk.frac * 100).toFixed(1)}%"><span class="pt-thermo-tick-line"></span><span class="pt-thermo-tick-lbl">${tk.label}</span></div>`;
  }
  return `<div class="pt-thermo">`
    + `<div class="pt-thermo-tube"><div class="pt-thermo-fill" id="${id}-fill" style="height:0%;background:linear-gradient(180deg,${col},${shade(col)})"></div></div>`
    + `<div class="pt-thermo-ticks">${t}</div>`
    + `<div class="pt-thermo-bulb" style="background:${col};box-shadow:0 0 16px ${col}99"></div>`
    + `</div>`;
}

/** Set a thermometer fill to a fraction (0..1). */
export function setThermo(root, id, frac, color) {
  const el = (root || document).querySelector('#' + id + '-fill');
  if (!el) return;
  el.style.height = (clamp01(frac) * 100).toFixed(1) + '%';
  if (color) {
    el.style.background = 'linear-gradient(180deg,' + color + ',' + shade(color) + ')';
    const thermo = el.closest('.pt-thermo');
    const bulb = thermo && thermo.querySelector('.pt-thermo-bulb');
    if (bulb) { bulb.style.background = color; bulb.style.boxShadow = '0 0 16px ' + color + '99'; }
  }
}

/**
 * Build chained mempool tanks. Returns an HTML string.
 * opts: { ntanks (default 3) }. Each tank = one block body (MAX_BLOCK_BODY).
 * Creates `mp-tank-${i}` (container) and `mp-liq-${i}` (liquid) + `mp-mf-${i}`.
 */
const TANK_COL = ['#36e0d4', '#ffc24a', '#ff5a3c', '#ff3a8c'];
export function tanksHTML(opts) {
  const n = (opts && opts.ntanks) || 3;
  let s = `<div class="pt-tanks" id="pt-tanks">`;
  for (let i = 0; i < n; i++) {
    const c = TANK_COL[Math.min(i, TANK_COL.length - 1)];
    s += `<div class="pt-tank" id="mp-tank-${i}">`
       + `<div class="pt-tank-cap">${i + 1}&times;</div>`
       + `<div class="pt-tank-liq" id="mp-liq-${i}" style="height:0%;background:${c};box-shadow:0 0 16px ${c}88"></div>`
       + `<div class="pt-tank-mf" id="mp-mf-${i}"></div>`
       + `</div>`;
  }
  s += `</div>`;
  return s;
}

/**
 * Paint the tanks from a byte count. full = bytes for ONE tank (one block).
 * Fills tank 0 first; overflow cascades into 1, 2, ... Returns the percent.
 */
export function paintTanks(root, bytes, full, ntanks) {
  const n = ntanks || 3;
  const r = root || document;
  for (let i = 0; i < n; i++) {
    const lo = i * full;
    const frac = clamp01((bytes - lo) / full);
    const liq = r.querySelector('#mp-liq-' + i);
    if (liq) {
      liq.style.height = (frac * 100).toFixed(1) + '%';
      // tank 0 colours by fill (green<34, amber<67, red); overflow tanks always red
      const c = i > 0 ? '#ff5a3c' : (frac < 0.34 ? '#5dff9b' : frac < 0.67 ? '#ffc24a' : '#ff5a3c');
      liq.style.background = c;
      liq.style.boxShadow = '0 0 16px ' + c + '88';
    }
    const tank = r.querySelector('#mp-tank-' + i);
    if (tank) {
      tank.classList.toggle('active', frac > 0 && frac < 1);
      tank.classList.toggle('spill', i > 0 && frac > 0);
    }
  }
  return Math.round((bytes / full) * 100);
}

/** Flash all tanks green (a block minted, mempool drained). */
export function flashMint(root, ntanks) {
  const n = ntanks || 3;
  const r = root || document;
  for (let i = 0; i < n; i++) {
    const mf = r.querySelector('#mp-mf-' + i);
    if (!mf) continue;
    mf.style.transition = 'none';
    mf.style.opacity = '0.85';
    setTimeout(() => { mf.style.transition = 'opacity 1s'; mf.style.opacity = '0'; }, 40);
  }
}

/** Darken a hex colour ~30% for the thermometer gradient foot. */
function shade(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const d = (h) => Math.max(0, Math.round(parseInt(h, 16) * 0.62)).toString(16).padStart(2, '0');
  return `#${d(m[1])}${d(m[2])}${d(m[3])}`;
}
