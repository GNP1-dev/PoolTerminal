/**
 * PoolTerminal — MAP view (dedicated, full-size relay/peer map).
 *
 * Separate from the small NOW-tab relay widget (ui/relay-map.js) — that one is
 * left untouched. This is the rich, full-screen version: the operator's node as
 * a gold anchor, every geolocated peer plotted, connection lines coloured by
 * RTT, plus a side panel with live stats — total/located peers, an RTT-band
 * breakdown, and a ranked geographic distribution (peers per country).
 *
 * Reuses the shared, efficient geo cache (data/geo-query.js): NOW already
 * populates it, so switching here adds no extra geo-API calls. Peers arrive via
 * updateMapPeers(peers), called from the live loop only while this tab is open.
 *
 * Equirectangular projection, same maths as the NOW widget so geography lines
 * up; the basemap GeoJSON is the same cached Natural Earth 110m land path.
 */

import { getCachedGeo, getOwnLocation, lookupGeoBatch } from '../data/geo-query.js';

const W = 1000;
const H = 500;
const WORLD_URL   = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_land.geojson';
// MAP-specific cache key — the NOW widget caches a 720×360 path under its own
// key; reusing it here would plot land + peers at mismatched scales (peers land
// in the wrong country). This key stores the 1000×500 path for this view.
const WORLD_CACHE = 'pt-world-map-path-1000x500-v1';

let worldPath = null;
let myLocation = null;
let lastPeers = [];
let mounted = false;
let ownInFlight = false;

function lngToX(lng) { return (lng + 180) * W / 360; }
function latToY(lat) { return (90  - lat) * H / 180; }

function rttColor(rtt) {
  if (rtt == null) return '#667';
  const c = Math.max(0, Math.min(rtt, 300));
  return `hsl(${(120 - (c / 300) * 120).toFixed(0)}, 70%, 55%)`;
}
function rttBand(rtt) {
  if (rtt == null) return 'unknown';
  if (rtt < 50) return 'fast';
  if (rtt < 150) return 'medium';
  return 'slow';
}
function escapeXml(s) {
  return String(s || '').replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  })[c]);
}

const MAP_HTML = `
<div class="pt-map">
  <style>
    .pt-map { display: grid; grid-template-columns: 1fr 280px; gap: 12px; height: 100%; padding: 4px; box-sizing: border-box; }
    .pt-map-canvas { background: #0a0f16; border: 1px solid rgba(110,140,180,0.25); border-radius: 6px; overflow: hidden; min-height: 0; }
    .pt-map-canvas svg { width: 100%; height: 100%; display: block; }
    .pt-map-side { display: flex; flex-direction: column; gap: 10px; font: 400 12px ui-monospace, monospace; color: #c8d4e0; overflow-y: auto; }
    .pt-map-card { background: rgba(20,30,45,0.6); border: 1px solid rgba(110,140,180,0.2); border-radius: 6px; padding: 10px 12px; }
    .pt-map-card h3 { margin: 0 0 8px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #7a90a8; font-weight: 600; }
    .pt-map-stat { display: flex; justify-content: space-between; padding: 2px 0; }
    .pt-map-stat .v { color: #e8f0f8; font-weight: 600; }
    .pt-map-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; }
    .pt-map-row .sw { width: 9px; height: 9px; border-radius: 50%; flex: none; }
    .pt-map-row .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pt-map-row .ct { color: #e8f0f8; font-weight: 600; }
    .pt-map-bar { height: 4px; border-radius: 2px; background: rgba(110,140,180,0.15); margin-top: 3px; overflow: hidden; }
    .pt-map-bar > i { display: block; height: 100%; }
    .pt-map-meta { color: #7a90a8; font-size: 11px; }
  </style>
  <div class="pt-map-canvas"><svg id="map-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"></svg></div>
  <div class="pt-map-side">
    <div class="pt-map-card">
      <h3>This node</h3>
      <div id="map-self" class="pt-map-meta">locating…</div>
    </div>
    <div class="pt-map-card">
      <h3>Peers</h3>
      <div class="pt-map-stat"><span>Total</span><span class="v" id="map-total">—</span></div>
      <div class="pt-map-stat"><span>Located</span><span class="v" id="map-located">—</span></div>
    </div>
    <div class="pt-map-card">
      <h3>Latency (RTT)</h3>
      <div id="map-rtt"></div>
    </div>
    <div class="pt-map-card">
      <h3>Geography</h3>
      <div id="map-geo"><div class="pt-map-meta">awaiting peers…</div></div>
    </div>
  </div>
</div>`;

async function loadWorldMap() {
  const cached = localStorage.getItem(WORLD_CACHE);
  if (cached) return cached;
  try {
    const r = await fetch(WORLD_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const geo = await r.json();
    let d = '';
    for (const feature of geo.features) {
      const raw = feature.geometry.coordinates;
      const polys = feature.geometry.type === 'Polygon' ? [raw] : raw;
      for (const poly of polys) {
        for (const ring of poly) {
          ring.forEach(([lng, lat], i) => {
            d += (i === 0 ? 'M' : 'L') + lngToX(lng).toFixed(1) + ',' + latToY(lat).toFixed(1) + ' ';
          });
          d += 'Z ';
        }
      }
    }
    localStorage.setItem(WORLD_CACHE, d);
    return d;
  } catch (e) {
    console.warn('[map-view] world load failed:', e.message);
    return '';
  }
}

async function tryResolveOwn() {
  if (myLocation || ownInFlight) return;
  ownInFlight = true;
  try {
    const loc = await getOwnLocation();
    if (loc) { myLocation = loc; paint(); }
  } finally { ownInFlight = false; }
}

function paint() {
  const svg = document.getElementById('map-svg');
  if (!svg) return;
  const parts = [];

  // graticule
  for (let lng = -180; lng <= 180; lng += 30) {
    const x = lngToX(lng);
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="rgba(80,100,130,0.10)" stroke-width="0.5"/>`);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = latToY(lat);
    parts.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="rgba(80,100,130,0.10)" stroke-width="0.5"/>`);
  }
  if (worldPath) {
    parts.push(`<path d="${worldPath}" fill="rgba(50,70,95,0.5)" stroke="rgba(110,140,180,0.6)" stroke-width="0.4" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`);
  }

  // connection lines (need own location)
  if (myLocation && lastPeers.length) {
    const mx = lngToX(myLocation.lng), my = latToY(myLocation.lat);
    for (const p of lastPeers) {
      const g = getCachedGeo(p.ip);
      if (!g) continue;
      parts.push(`<line x1="${mx.toFixed(1)}" y1="${my.toFixed(1)}" x2="${lngToX(g.lng).toFixed(1)}" y2="${latToY(g.lat).toFixed(1)}" stroke="${rttColor(p.rtt)}" stroke-width="0.7" opacity="0.5"/>`);
    }
  }

  // peer dots
  for (const p of lastPeers) {
    const g = getCachedGeo(p.ip);
    if (!g) continue;
    const rtt = p.rtt == null ? '—' : (p.rtt < 1 ? '<1ms' : Math.round(p.rtt) + 'ms');
    const tip = escapeXml(`${p.ip}:${p.port}\n${g.city || ''}${g.city ? ', ' : ''}${g.country || ''}\n${g.as || ''}\nRTT ${rtt}`);
    parts.push(`<circle cx="${lngToX(g.lng).toFixed(1)}" cy="${latToY(g.lat).toFixed(1)}" r="3" fill="${rttColor(p.rtt)}" stroke="rgba(0,0,0,0.6)" stroke-width="0.4"><title>${tip}</title></circle>`);
  }

  // own node on top
  if (myLocation) {
    const mx = lngToX(myLocation.lng), my = latToY(myLocation.lat);
    const tip = escapeXml(`This node · ${myLocation.city || ''}${myLocation.city ? ', ' : ''}${myLocation.country || ''}\n${myLocation.as || ''}`);
    parts.push(`<circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="6.5" fill="#f1c40f" stroke="#000" stroke-width="0.8"><title>${tip}</title></circle>`);
  }

  svg.innerHTML = parts.join('');
  paintSidePanel();
}

function setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }

function paintSidePanel() {
  // self
  if (myLocation) {
    setText('map-self', `${myLocation.city ? myLocation.city + ', ' : ''}${myLocation.country || ''} · ${myLocation.as || ''}`);
  }
  const located = lastPeers.filter((p) => getCachedGeo(p.ip)).length;
  setText('map-total', String(lastPeers.length));
  setText('map-located', String(located));

  // RTT bands
  const bands = { fast: 0, medium: 0, slow: 0, unknown: 0 };
  for (const p of lastPeers) bands[rttBand(p.rtt)]++;
  const bandMeta = [
    ['fast', 'Fast (<50ms)', rttColor(10)],
    ['medium', 'Medium (50–150ms)', rttColor(100)],
    ['slow', 'Slow (>150ms)', rttColor(250)],
    ['unknown', 'Unknown', rttColor(null)],
  ];
  const total = lastPeers.length || 1;
  const rttEl = document.getElementById('map-rtt');
  if (rttEl) {
    rttEl.innerHTML = bandMeta.map(([k, label, col]) => {
      const n = bands[k];
      const pct = ((n / total) * 100).toFixed(0);
      return `<div class="pt-map-row"><span class="sw" style="background:${col}"></span><span class="nm">${label}</span><span class="ct">${n}</span></div>` +
             `<div class="pt-map-bar"><i style="width:${pct}%;background:${col}"></i></div>`;
    }).join('');
  }

  // geographic distribution (peers per country, ranked)
  const byCountry = new Map();
  for (const p of lastPeers) {
    const g = getCachedGeo(p.ip);
    if (!g || !g.country) continue;
    byCountry.set(g.country, (byCountry.get(g.country) || 0) + 1);
  }
  const ranked = [...byCountry.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const geoEl = document.getElementById('map-geo');
  if (geoEl) {
    if (!ranked.length) {
      geoEl.innerHTML = '<div class="pt-map-meta">awaiting located peers…</div>';
    } else {
      const max = ranked[0][1] || 1;
      geoEl.innerHTML = ranked.map(([country, n]) =>
        `<div class="pt-map-row"><span class="nm">${escapeXml(country)}</span><span class="ct">${n}</span></div>` +
        `<div class="pt-map-bar"><i style="width:${((n / max) * 100).toFixed(0)}%;background:#4a90d9"></i></div>`
      ).join('');
    }
  }
}

/** Live peer feed from the loop (only called while the MAP tab is active). */
export function updateMapPeers(peers = []) {
  lastPeers = peers;
  if (!myLocation) tryResolveOwn();
  if (peers.length) {
    lookupGeoBatch(peers.map((p) => p.ip)).then(() => paint());
  }
  paint();
}

export async function mountMap(canvas) {
  canvas.innerHTML = MAP_HTML;
  mounted = true;
  paint();                          // immediate basemap/grid
  if (!worldPath) worldPath = await loadWorldMap();
  paint();
  await tryResolveOwn();
  paint();
}

export function unmountMap() { mounted = false; }
export function isMapMounted() { return mounted; }
