/**
 * PoolTerminal — Mini relay map (NOW view placeholder).
 *
 * Now sized to a proper 2:1 equirectangular world aspect (viewBox 720x360),
 * so it sits nicely in the bottom-row 2-col panel where it has real height.
 * Still a placeholder — the full MAP tab will use D3 + Natural Earth later.
 */

const SVGNS = 'http://www.w3.org/2000/svg';
const W = 720;
const H = 360;

const RELAYS = [
  { label: 'BP · Harrogate',     lat:  53.99, lon:   -1.54, rtt: 0,   isBP: true },
  { label: 'Relay · Frankfurt',  lat:  50.11, lon:    8.68, rtt: 25  },
  { label: 'Relay · Virginia',   lat:  38.60, lon:  -77.40, rtt: 85  },
  { label: 'Relay · Singapore',  lat:   1.35, lon:  103.82, rtt: 200 },
  { label: 'Relay · Sydney',     lat: -33.87, lon:  151.21, rtt: 320 },
];

function byId(id) { return document.getElementById(id); }

function project(lat, lon) {
  return {
    x: ((lon + 180) / 360) * W,
    y: ((90 - lat) / 180) * H,
  };
}

function rttColor(rtt) {
  if (rtt < 50)  return 'var(--pt-status-good)';
  if (rtt < 150) return 'var(--pt-status-warn)';
  return 'var(--pt-status-bad)';
}

function jitter(rtt) {
  return Math.max(1, Math.round(rtt * (0.9 + Math.random() * 0.2)));
}

function lineEl(x1, y1, x2, y2, colorVar, width) {
  const el = document.createElementNS(SVGNS, 'line');
  el.setAttribute('x1', x1); el.setAttribute('y1', y1);
  el.setAttribute('x2', x2); el.setAttribute('y2', y2);
  el.setAttribute('stroke-width', width);
  el.setAttribute('vector-effect', 'non-scaling-stroke');
  el.style.stroke = colorVar;
  return el;
}

function circleEl(cx, cy, r, fillVar, titleText) {
  const el = document.createElementNS(SVGNS, 'circle');
  el.setAttribute('cx', cx); el.setAttribute('cy', cy); el.setAttribute('r', r);
  el.style.fill = fillVar;
  if (titleText) {
    const t = document.createElementNS(SVGNS, 'title');
    t.textContent = titleText;
    el.appendChild(t);
  }
  return el;
}

export function renderRelayMap() {
  const svg = byId('rm-svg');
  const meta = byId('rm-meta');
  if (!svg) return;

  const live = RELAYS.map((r) => ({ ...r, rttLive: r.isBP ? 0 : jitter(r.rtt) }));
  const others = live.filter((r) => !r.isBP);
  const avg = Math.round(others.reduce((a, b) => a + b.rttLive, 0) / others.length);
  if (meta) meta.textContent = `${live.length} nodes · avg RTT ${avg}ms`;

  while (svg.firstChild) svg.removeChild(svg.firstChild);

  // Grid every 30°
  for (let lon = 0; lon <= W; lon += W / 12) {
    svg.appendChild(lineEl(lon, 0, lon, H, 'var(--pt-border)', 0.5));
  }
  for (let lat = 0; lat <= H; lat += H / 6) {
    svg.appendChild(lineEl(0, lat, W, lat, 'var(--pt-border)', 0.5));
  }
  // Equator + prime meridian emphasised
  svg.appendChild(lineEl(0, H / 2, W, H / 2, 'var(--pt-text-disabled)', 0.75));
  svg.appendChild(lineEl(W / 2, 0, W / 2, H, 'var(--pt-text-disabled)', 0.75));

  // Relay dots
  for (const r of live) {
    const p = project(r.lat, r.lon);
    const color = r.isBP ? 'var(--pt-accent-blue-bright)' : rttColor(r.rttLive);
    const radius = r.isBP ? 7 : 5;
    const title = r.isBP ? r.label : `${r.label} — ${r.rttLive}ms`;
    svg.appendChild(circleEl(p.x, p.y, radius, color, title));
  }
}
