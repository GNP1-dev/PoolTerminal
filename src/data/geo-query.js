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

// DEMO ISOLATION /*demo-world-v99*/: in demo mode every geo answer comes from
// the synthetic world — the batch lookup and the own-location probe are the
// two places demo used to leak: ip-api.com was called (via the node's curl!)
// and the OWN-IP lookup geolocated the user's real home. The cached-entry
// getter is gated too, because the persisted cache may hold a previous LIVE
// session's real locations under the self key.
import { getMode } from './index.js';
import { demoGeo, demoOwnGeo } from './demo-world.js';
const _demo = () => { try { return getMode() === 'demo'; } catch { return false; } };

export function getCachedGeo(ip) {
  if (_demo()) return demoGeo(ip);
  return cache.get(ip) || null;
}

/**
 * Resolve any IPs not already in cache via a single batch call.
 * Returns when done (whether successful or not).
 */
export async function lookupGeoBatch(ips, runner) {
  if (_demo()) return;   // demo IPs resolve via getCachedGeo -> demoGeo; no network ever /*demo-world-v99*/
  const run = runner || runCmd;
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
    out = await run(cmd);
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
export async function getOwnLocation(runner, key) {
  if (_demo()) return demoOwnGeo();   // never geolocate the real host in demo /*demo-world-v99*/
  const run = runner || runCmd;
  const selfKey = key || SELF_KEY;
  if (cache.has(selfKey)) return cache.get(selfKey);

  const cmd =
    `curl -sf --max-time 4 ` +
    `'http://ip-api.com/json?fields=${BATCH_FIELDS}'`;

  let out;
  try {
    out = await run(cmd);
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
    cache.set(selfKey,    loc);
    cache.set(data.query,  loc);
    saveCache();
    console.log(`[geo] self (${selfKey}): ${loc.city}, ${loc.country} (${loc.ip})`);
    return loc;
  } catch (err) {
    console.warn('[geo] self parse failed:', err.message);
    return null;
  }
}
