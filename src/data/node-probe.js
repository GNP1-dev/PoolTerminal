/**
 * PoolTerminal — Node role probe.
 *
 * After SSH connect, identify the cardano-node process this session is bound
 * to (the one that owns $CARDANO_NODE_SOCKET_PATH) and inspect its command
 * line. A BP is fingerprinted by the presence of --shelley-kes-key — only a
 * block producer is given KES keys. Anything else is a relay.
 *
 * Also extracts --port and --topology so later phases (peers, topology
 * health) have the exact paths to work with.
 *
 * Single SSH call, no privileges required (ps + fuser are user-level).
 */

import { invoke } from './tauri.js';
import { getSession } from './session.js';

async function runCmd(command) {
  const r = await invoke('ssh_run', { command });
  if (typeof r === 'string') return r;
  return r?.stdout ?? '';
}

function parseKV(out) {
  const kv = {};
  out.split('\n').forEach((line) => {
    const eq = line.indexOf('=');
    if (eq > 0) {
      const k = line.slice(0, eq).trim();
      kv[k] = line.slice(eq + 1);
    }
  });
  return kv;
}

/**
 * Run the probe. Returns:
 *   { role: 'BP' | 'RELAY' | 'UNKNOWN',
 *     pid: number|null, port: number|null,
 *     topologyPath: string|null, args: string }
 *
 * On any failure, returns UNKNOWN — caller decides how to display that.
 */
export async function probeNode() {
  const e = getSession().envVars || {};
  const socket = e.CARDANO_NODE_SOCKET_PATH || '';

  if (!socket) {
    return { role: 'UNKNOWN', pid: null, port: null, topologyPath: null, args: '' };
  }

  // Identify the cardano-node PID that owns the configured socket. fuser is
  // the most reliable; fall back to scanning ps for --socket-path matches.
  // The awk uses [c]ardano-node to skip the grep itself.
  const cmd =
    `S='${socket.replace(/'/g, "'\\''")}'; ` +
    `PID=$(fuser "$S" 2>/dev/null | tr -d ' \\n'); ` +
    `if [ -z "$PID" ]; then ` +
    `  PID=$(ps -eo pid,args 2>/dev/null | awk -v s="$S" '/[c]ardano-node/ && index($0, "--socket-path " s) { print $1; exit }'); ` +
    `fi; ` +
    `if [ -z "$PID" ]; then echo "PID="; echo "ARGS="; exit 0; fi; ` +
    `echo "PID=$PID"; ` +
    `echo -n "ARGS="; ps -p "$PID" -o args= 2>/dev/null`;

  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[node-probe] SSH failure:', err.message);
    return { role: 'UNKNOWN', pid: null, port: null, topologyPath: null, args: '' };
  }

  const kv = parseKV(out);
  const pid = parseInt(kv.PID || '', 10) || null;
  const args = kv.ARGS || '';

  if (!pid || !args) {
    console.warn('[node-probe] could not identify cardano-node PID for socket', socket);
    return { role: 'UNKNOWN', pid, port: null, topologyPath: null, args };
  }

  const isBp = / --shelley-kes-key /.test(' ' + args + ' ');
  const portMatch = args.match(/--port\s+(\d+)/);
  const topoMatch = args.match(/--topology\s+(\S+)/);

  const result = {
    role: isBp ? 'BP' : 'RELAY',
    pid,
    port: portMatch ? parseInt(portMatch[1], 10) : null,
    topologyPath: topoMatch ? topoMatch[1] : null,
    args,
  };

  console.log(
    `[node-probe] pid=${result.pid} role=${result.role} ` +
    `port=${result.port} topology=${result.topologyPath}`
  );

  return result;
}
