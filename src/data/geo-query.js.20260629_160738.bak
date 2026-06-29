/**
 * PoolTerminal — IP geolocation.
 *
 * Looks up lat/lng/country/city/AS for IPs by POSTing to ip-api.com over
 * the existing SSH session (the node has internet egress; the WebView may
 * have CORS restrictions). Free tier: 45 req/min, 100 IPs per batch.
 *
 * Results are cached forever in localStorage (IPs don't change location).
 * On every peers refresh we filter to IPs we haven't seen yet, and only
 * hit the API for those — steady-state burns no requests.
 *
 * Private (RFC1918) IPs are skipped; they'd come back unsuccessful anyway.
 */

import { invoke } from './tauri.js';

const CACHE_KEY  = 'pt-geo-cache-v1';
const SELF_KEY   = '__self__';
const BATCH_FIELDS = 'status,lat,lon,country,countryCode,city,as,query';

let cache = new Map();

(function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) cache = new Map(Object.entries(JSON.parse(raw)));
  } catch (e) {
    console.warn('[geo] cache load failed:', e.message);
  }
})();

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(cache)));
  } catch (e) {
    console.warn('[geo] cache save failed:', e.message);
  }
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('169.254.')) return true;
  const m = ip.match(/^172\.(\d+)\./);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  return false;
}

async function runCmd(command) {
  const r = await invoke('ssh_run', { command });
  if (typeof r === 'string') return r;
  return r?.stdout ?? '';
}

export function getCachedGeo(ip) {
  return cache.get(ip) || null;
}

/**
 * Resolve any IPs not already in cache via a single batch call.
 * Returns when done (whether successful or not).
 */
export async function lookupGeoBatch(ips) {
  const need = [...new Set(ips)].filter(
    (ip) => ip && !cache.has(ip) && !isPrivateIp(ip)
  );
  if (need.length === 0) return;

  const slice = need.slice(0, 100);
  const body = JSON.stringify(slice.map((ip) => ({ query: ip })));
  // The single-quote shell-escape mirrors what node-probe does.
  const escaped = body.replace(/'/g, "'\\''");
  const cmd =
    `echo '${escaped}' | ` +
    `curl -sf --max-time 6 -X POST -H 'Content-Type: application/json' ` +
    `-d @- 'http://ip-api.com/batch?fields=${BATCH_FIELDS}'`;

  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[geo] batch SSH failure:', err.message);
    return;
  }
  if (!out || !out.trim()) return;

  let data;
  try {
    data = JSON.parse(out);
  } catch (err) {
    console.warn('[geo] batch parse failed:', err.message);
    return;
  }

  let added = 0;
  for (const item of data) {
    if (item.status === 'success' && item.lat != null && item.lon != null) {
      cache.set(item.query, {
        ip:          item.query,
        lat:         item.lat,
        lng:         item.lon,
        country:     item.country,
        countryCode: item.countryCode,
        city:        item.city,
        as:          item.as,
      });
      added++;
    }
  }
  if (added) {
    saveCache();
    console.log(`[geo] +${added} IPs (cache=${cache.size})`);
  }
}

/**
 * Resolve our own node's public location. Cached after first call.
 */
export async function getOwnLocation() {
  if (cache.has(SELF_KEY)) return cache.get(SELF_KEY);

  const cmd =
    `curl -sf --max-time 4 ` +
    `'http://ip-api.com/json?fields=${BATCH_FIELDS}'`;

  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[geo] self SSH failure:', err.message);
    return null;
  }
  if (!out) return null;

  try {
    const data = JSON.parse(out);
    if (data.status !== 'success') return null;
    const loc = {
      ip:          data.query,
      lat:         data.lat,
      lng:         data.lon,
      country:     data.country,
      countryCode: data.countryCode,
      city:        data.city,
      as:          data.as,
    };
    cache.set(SELF_KEY,    loc);
    cache.set(data.query,  loc);
    saveCache();
    console.log(`[geo] self: ${loc.city}, ${loc.country} (${loc.ip})`);
    return loc;
  } catch (err) {
    console.warn('[geo] self parse failed:', err.message);
    return null;
  }
}
