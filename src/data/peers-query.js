/**
 * PoolTerminal — Peers query.
 *
 * Single SSH call: ss -tnp state established | grep pid=<our_node>,
 * Each line yields one peer (local IP:port, remote IP:port).
 *
 * Direction classification:
 *   local port == probed node port → inbound (someone connected to us)
 *   otherwise                      → outbound (we connected to them)
 *
 * Returns { inbound:[{ip,port,localPort}], outbound:[...], total, timestamp }.
 * The full peer list is kept module-local for later phases (table, map,
 * geolocation). Step 2 only uses the counts via getLastPeerData().
 */

import { invoke } from './tauri.js';
import { getNodeProbe } from './session.js';

let lastResult = null;

async function runCmd(command) {
  const r = await invoke('ssh_run', { command });
  if (typeof r === 'string') return r;
  return r?.stdout ?? '';
}

export function getLastPeerData() {
  return lastResult;
}

/**
 * Enumerate this node's established TCP peers.
 * Returns null if the probe hasn't run yet (no PID/port known).
 */
export async function queryPeers() {
  const probe = getNodeProbe();
  if (!probe || !probe.pid || !probe.port) {
    return null;
  }

  const t0 = performance.now();
  const cmd = `ss -tnp state established 2>/dev/null | grep "pid=${probe.pid},"`;
  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[peers] SSH failure:', err.message);
    return null;
  }

  const inbound = [];
  const outbound = [];
  const ipPortRe = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)/g;

  out.split('\n').forEach((line) => {
    if (!line.trim()) return;
    const pairs = [];
    let m;
    ipPortRe.lastIndex = 0;
    while ((m = ipPortRe.exec(line)) !== null) {
      const ip = m[1];
      const port = parseInt(m[2], 10);
      if (ip === '0.0.0.0' || ip === '127.0.0.1') continue;
      pairs.push({ ip, port });
    }
    if (pairs.length < 2) return;

    const local = pairs[0];
    const remote = pairs[1];

    // No remote-endpoint dedup: each ss line is a distinct kernel socket.
    // Bidirectional sessions (relay dials BP AND BP dials relay) legitimately
    // share a remote endpoint but are two separate connections.
    const peer = { ip: remote.ip, port: remote.port, localPort: local.port };
    if (local.port === probe.port) {
      inbound.push(peer);
    } else {
      outbound.push(peer);
    }
  });

  lastResult = {
    inbound,
    outbound,
    total: inbound.length + outbound.length,
    timestamp: Date.now(),
  };

  console.log(
    `[peers] ${Math.round(performance.now() - t0)}ms · ` +
    `${lastResult.total} total · IN ${inbound.length} · OUT ${outbound.length}`
  );

  return lastResult;
}
