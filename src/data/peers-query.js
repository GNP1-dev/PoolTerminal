/**
 * PoolTerminal — Peers query.
 *
 * Two SSH calls in parallel:
 *   ss -tnpi  → established connections + RTT (kernel TCP info)
 *   curl prom → cardano-node Prometheus metrics (in/out/bidir/duplex)
 *
 * Returns:
 *   { peers:    [{ ip, port, localPort, rtt }, …],   // ss-based, sorted by RTT
 *     total:    number,
 *     metrics:  { incomingConns, outgoingConns, ... } | null,
 *     timestamp: number }
 *
 * NOTE on P2P direction:
 *   cardano-node P2P uses SO_REUSEPORT, so even outbound TCP connections
 *   bind to the listen port. ss alone cannot distinguish OUT from IN for
 *   P2P peers. We therefore present a single sorted list of peers in the
 *   panel body, and rely on Prometheus metrics for the in/out breakdown
 *   shown in the panel header.
 *   gLiveView (cardano-community) confirms this limitation in its docs.
 */

import { invoke } from './tauri.js';
import { getNodeProbe } from './session.js';
import { queryMetrics } from './metrics-query.js';

let lastResult = null;

async function runCmd(command) {
  const r = await invoke('ssh_run', { command });
  if (typeof r === 'string') return r;
  return r?.stdout ?? '';
}

export function getLastPeerData() { return lastResult; }

function parseAddrPair(line) {
  const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)/g;
  const m1 = re.exec(line); if (!m1) return null;
  const m2 = re.exec(line); if (!m2) return null;
  return {
    localIp:    m1[1],
    localPort:  parseInt(m1[2], 10),
    remoteIp:   m2[1],
    remotePort: parseInt(m2[2], 10),
  };
}

function parseRtt(statsLine) {
  if (!statsLine) return null;
  const m = statsLine.match(/\srtt:([\d.]+)\//);
  return m ? parseFloat(m[1]) : null;
}

async function queryPeerList(probe) {
  const cmd = `ss -tnpi state established 2>/dev/null`;
  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[peers] SSH failure:', err.message);
    return null;
  }

  const peers = [];
  const pidTag = `pid=${probe.pid},`;
  const lines = out.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(pidTag)) continue;

    const parsed = parseAddrPair(line);
    if (!parsed) continue;
    if (
      parsed.remoteIp === '127.0.0.1' ||
      parsed.localIp === '127.0.0.1' ||
      parsed.remoteIp === '0.0.0.0'
    ) continue;

    let rtt = null;
    if (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next && /^\s+\S/.test(next)) rtt = parseRtt(next);
    }

    peers.push({
      ip:        parsed.remoteIp,
      port:      parsed.remotePort,
      localPort: parsed.localPort,
      rtt,
    });
  }

  // Fastest first, unknown RTTs last
  peers.sort((a, b) => {
    if (a.rtt == null && b.rtt == null) return 0;
    if (a.rtt == null) return 1;
    if (b.rtt == null) return -1;
    return a.rtt - b.rtt;
  });

  return { peers, total: peers.length };
}

export async function queryPeers() {
  const probe = getNodeProbe();
  if (!probe || !probe.pid) return null;

  const t0 = performance.now();
  const [peerList, metrics] = await Promise.all([
    queryPeerList(probe),
    queryMetrics(),
  ]);
  if (!peerList) return null;

  lastResult = {
    peers:     peerList.peers,
    total:     peerList.total,
    metrics,
    timestamp: Date.now(),
  };

  console.log(
    `[peers] ${Math.round(performance.now() - t0)}ms · ` +
    `${lastResult.total} sockets · ` +
    (metrics
      ? `metrics OUT ${metrics.outgoingConns} / IN ${metrics.incomingConns}`
      : `no metrics (Prometheus disabled)`)
  );

  return lastResult;
}
