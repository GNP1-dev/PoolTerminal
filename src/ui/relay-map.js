/**
 * PoolTerminal — Relay map.
 *
 * Renders a world map (Natural Earth 110m land, public domain, fetched
 * once from jsDelivr CDN and persisted to localStorage) with:
 *   • our own node as a gold dot (slightly larger)
 *   • each established peer as a dot at its geolocated lat/lng
 *   • a line from us to each peer, coloured by kernel-measured RTT
 *
 * RTT colour gradient is continuous HSL hue from 120° (green, 0 ms) to
 * 0° (red, ≥300 ms) — so 50 ms ≈ yellow-green, 150 ms ≈ orange.
 *
 * Equirectangular projection: x = (lng+180) × W/360 ; y = (90-lat) × H/180.
 * SVG viewBox is 720×360 (a 2:1 ratio that matches the projection naturally).
 *
 * Own location uses SSH and may fail at mount time (before connect); we
 * retry on each renderRelayMap call until it succeeds, and we draw peer
 * dots regardless — only the connecting lines + gold self-dot wait for
 * own location.
 */

import { getCachedGeo, getOwnLocation, lookupGeoBatch } from '../data/geo-query.js';

const W = 720;
const H = 360;
const WORLD_URL   = 'https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_land.geojson';
const WORLD_CACHE = 'pt-world-map-path-v1';

let worldPath = null;
let myLocation = null;
let lastPeers = [];
let mapInitStarted = false;
let ownLocationInFlight = false;

function lngToX(lng) { return (lng + 180) * W / 360; }
function latToY(lat) { return (90  - lat) * H / 180; }

function rttColor(rtt) {
  if (rtt == null) return '#555';
  const clamped = Math.max(0, Math.min(rtt, 300));
  const hue = 120 - (clamped / 300) * 120;
  return `hsl(${hue.toFixed(0)}, 70%, 55%)`;
}

function escapeXml(s) {
  return String(s || '').replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
  })[c]);
}

async function loadWorldMap() {
  const cached = localStorage.getItem(WORLD_CACHE);
  if (cached) return cached;

  console.log('[map] fetching world map (one-time, ~150KB)…');
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
            d += (i === 0 ? 'M' : 'L') +
                 lngToX(lng).toFixed(1) + ',' + latToY(lat).toFixed(1) + ' ';
          });
          d += 'Z ';
        }
      }
    }
    localStorage.setItem(WORLD_CACHE, d);
    console.log(`[map] world map cached (${(d.length / 1024).toFixed(0)} KB)`);
    return d;
  } catch (e) {
    console.warn('[map] failed to load:', e.message);
    return '';
  }
}

async function tryResolveOwnLocation() {
  if (myLocation || ownLocationInFlight) return;
  ownLocationInFlight = true;
  try {
    const loc = await getOwnLocation();
    if (loc) {
      myLocation = loc;
      paint(lastPeers);
    }
  } finally {
    ownLocationInFlight = false;
  }
}

export async function initRelayMap() {
  if (mapInitStarted) return;
  mapInitStarted = true;

  // Paint the empty grid immediately so the panel isn't blank.
  paint([]);

  // World map fetch is HTTPS direct from the WebView and works pre-SSH.
  worldPath = await loadWorldMap();
  paint(lastPeers);

  // First own-location attempt; will likely fail if SSH isn't up yet.
  // renderRelayMap() retries on each subsequent peers refresh until success.
  await tryResolveOwnLocation();
  paint(lastPeers);
}

function paint(peers) {
  const svg = document.getElementById('rm-svg');
  if (!svg) return;

  const parts = [];

  // Subtle background grid (always visible, even before world map loads)
  for (let lng = -180; lng <= 180; lng += 30) {
    const x = lngToX(lng);
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${H}" stroke="rgba(80,100,130,0.10)" stroke-width="0.5"/>`);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = latToY(lat);
    parts.push(`<line x1="0" y1="${y}" x2="${W}" y2="${y}" stroke="rgba(80,100,130,0.10)" stroke-width="0.5"/>`);
  }

  // World map landmasses
  if (worldPath) {
    parts.push(
      `<path d="${worldPath}" ` +
      `fill="rgba(50,70,95,0.5)" ` +
      `stroke="rgba(110,140,180,0.6)" stroke-width="0.4" ` +
      `stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`
    );
  }

  // Lines from our node to each located peer — only when we know our location
  if (myLocation && peers.length) {
    const myX = lngToX(myLocation.lng);
    const myY = latToY(myLocation.lat);
    for (const p of peers) {
      const g = getCachedGeo(p.ip);
      if (!g) continue;
      const px = lngToX(g.lng);
      const py = latToY(g.lat);
      parts.push(
        `<line x1="${myX.toFixed(1)}" y1="${myY.toFixed(1)}" ` +
        `x2="${px.toFixed(1)}" y2="${py.toFixed(1)}" ` +
        `stroke="${rttColor(p.rtt)}" stroke-width="0.6" opacity="0.55"/>`
      );
    }
  }

  // Peer dots — drawn regardless of own-location status
  for (const p of peers) {
    const g = getCachedGeo(p.ip);
    if (!g) continue;
    const px  = lngToX(g.lng);
    const py  = latToY(g.lat);
    const col = rttColor(p.rtt);
    const rtt = p.rtt == null ? '—' : (p.rtt < 1 ? '<1ms' : Math.round(p.rtt) + 'ms');
    const tip = escapeXml(
      `${p.ip}:${p.port}\n${g.city || ''}${g.city ? ', ' : ''}${g.country || ''}\n${g.as || ''}\nRTT ${rtt}`
    );
    parts.push(
      `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.2" ` +
      `fill="${col}" stroke="rgba(0,0,0,0.6)" stroke-width="0.3">` +
      `<title>${tip}</title></circle>`
    );
  }

  // Our own node, gold, drawn last so it sits on top
  if (myLocation) {
    const myX = lngToX(myLocation.lng);
    const myY = latToY(myLocation.lat);
    const myTip = escapeXml(
      `This node · ${myLocation.city || ''}${myLocation.city ? ', ' : ''}${myLocation.country || ''}\n${myLocation.as || ''}`
    );
    parts.push(
      `<circle cx="${myX.toFixed(1)}" cy="${myY.toFixed(1)}" r="5" ` +
      `fill="#f1c40f" stroke="#000" stroke-width="0.6">` +
      `<title>${myTip}</title></circle>`
    );
  }

  svg.innerHTML = parts.join('');

  // Meta line in the panel header
  const meta = document.getElementById('rm-meta');
  if (meta) {
    if (peers.length) {
      const located = peers.filter((p) => getCachedGeo(p.ip)).length;
      const selfTag = myLocation ? '' : ' · self pending';
      meta.textContent = `${located}/${peers.length} located${selfTag}`;
    } else if (worldPath) {
      meta.textContent = myLocation ? 'awaiting peers…' : 'awaiting SSH…';
    } else {
      meta.textContent = 'loading map…';
    }
  }
}

export function renderRelayMap(peers = []) {
  lastPeers = peers;

  // Re-try own-location every render until SSH is up and it succeeds.
  if (!myLocation) tryResolveOwnLocation();

  // Kick off geo lookups in the background for any new IPs.
  if (peers.length) {
    lookupGeoBatch(peers.map((p) => p.ip)).then(() => {
      paint(lastPeers);
    });
  }
  paint(peers);
}

/** Clear peer state on reconnect / mode switch. Keeps the world map and
 *  own location cached for efficiency (they don't change per-session). */
export function resetRelayMap() {
  lastPeers = [];
  paint([]);
}
