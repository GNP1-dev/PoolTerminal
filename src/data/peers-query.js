/**
 * PoolTerminal — Peers query.
 *
 * Single SSH call: `ss -tnpi state established` — includes TCP info per
 * connection so we get RTT alongside the addresses. JS filters by the
 * probed cardano-node PID.
 *
 * Direction classification (P2P-safe):
 *   remote port < 32768 → OUT  (we dialed them; remote is on its listen port)
 *   remote port >= 32768 → IN  (they dialed us; remote port is their ephemeral)
 *
 * The older "local port == node port" rule failed on P2P relays because
 * cardano-node uses SO_REUSEPORT — even outbound connections bind to the
 * listen port. Classifying by remote port is robust for both P2P and
 * non-P2P (BP) modes.
 *
 * BiDir / Duplex breakdown requires Prometheus metrics from the node — see
 * future step (cardano_node_metrics_connectionManager_*).
 *
 * Returns { inbound:[{ip,port,localPort,rtt}], outbound:[...], total, timestamp }.
 */

import { invoke } from './tauri.js';
import { getNodeProbe } from './session.js';

const EPHEMERAL_PORT_THRESHOLD = 32768;

let lastResult = null;

async function runCmd(command) {
  const r = await invoke('ssh_run', { command });
  if (typeof r === 'string') return r;
  return r?.stdout ?? '';
}

export function getLastPeerData() { return lastResult; }

function parseAddrPair(line) {
  // Find the first two ipv4:port pairs on the line. ss output:
  //   ESTAB 0 0  192.168.0.62:3001  78.31.67.243:3001  users:(...)
  const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)/g;
  const m1 = re.exec(line);
  if (!m1) return null;
  const m2 = re.exec(line);
  if (!m2) return null;
  return {
    localIp: m1[1],
    localPort: parseInt(m1[2], 10),
    remoteIp: m2[1],
    remotePort: parseInt(m2[2], 10),
  };
}

function parseRtt(statsLine) {
  if (!statsLine) return null;
  const m = statsLine.match(/\srtt:([\d.]+)\//);
  if (!m) return null;
  return parseFloat(m[1]);
}

export async function queryPeers() {
  const probe = getNodeProbe();
  if (!probe || !probe.pid) return null;

  const t0 = performance.now();
  // -t TCP, -n numeric, -p processes (for the pid= tag), -i TCP info (rtt).
  // Output has connection line followed by an indented stats line.
  const cmd = `ss -tnpi state established 2>/dev/null`;
  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[peers] SSH failure:', err.message);
    return null;
  }

  const inbound = [];
  const outbound = [];
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

    // RTT is on the immediately-following indented stats line.
    let rtt = null;
    if (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next && next.startsWith('\t') || (next && /^\s+\S/.test(next))) {
        rtt = parseRtt(next);
      }
    }

    const peer = {
      ip: parsed.remoteIp,
      port: parsed.remotePort,
      localPort: parsed.localPort,
      rtt,
    };

    if (parsed.remotePort < EPHEMERAL_PORT_THRESHOLD) {
      outbound.push(peer);
    } else {
      inbound.push(peer);
    }
  }

  // Within each direction, fastest peers first.
  const byRtt = (a, b) => {
    if (a.rtt == null && b.rtt == null) return 0;
    if (a.rtt == null) return 1;
    if (b.rtt == null) return -1;
    return a.rtt - b.rtt;
  };
  outbound.sort(byRtt);
  inbound.sort(byRtt);

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
