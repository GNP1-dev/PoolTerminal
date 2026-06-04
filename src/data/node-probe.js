/**
 * PoolTerminal — Node role probe.
 *
 * Single SSH call discovers everything about the connected cardano-node:
 *   pid          — owning process of $CARDANO_NODE_SOCKET_PATH
 *   port         — --port arg from cmdline
 *   role         — BP if --shelley-kes-key is present, else RELAY
 *   topology     — --topology arg
 *   prometheus   — if the same PID has a second listen socket, that's the
 *                  Prometheus port (typically 127.0.0.1:12800). null if not.
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

export async function probeNode() {
  const e = getSession().envVars || {};
  const socket = e.CARDANO_NODE_SOCKET_PATH || '';
  if (!socket) {
    return { role: 'UNKNOWN', pid: null, port: null, topologyPath: null, args: '', prometheusPort: null };
  }

  const cmd =
    `S='${socket.replace(/'/g, "'\\''")}'; ` +
    `PID=$(fuser "$S" 2>/dev/null | tr -d ' \\n'); ` +
    `if [ -z "$PID" ]; then ` +
    `  PID=$(ps -eo pid,args 2>/dev/null | awk -v s="$S" '/[c]ardano-node/ && index($0, "--socket-path " s) { print $1; exit }'); ` +
    `fi; ` +
    `if [ -z "$PID" ]; then echo "PID="; echo "ARGS="; echo "PROM_PORT="; exit 0; fi; ` +
    `echo "PID=$PID"; ` +
    `ARGS=$(ps -p "$PID" -o args= 2>/dev/null); ` +
    `echo "ARGS=$ARGS"; ` +
    // Node listen port from cmdline
    `NODE_PORT=$(echo "$ARGS" | grep -oP -- '--port[= ]+\\K[0-9]+'); ` +
    // Any TCP listener owned by this PID that isn't the node port = Prometheus
    `PROM_PORT=$(ss -tlnp 2>/dev/null | grep "pid=$PID," | awk '{print $4}' | awk -F: '{print $NF}' | grep -v "^$NODE_PORT$" | head -1); ` +
    `echo "PROM_PORT=$PROM_PORT"`;

  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[node-probe] SSH failure:', err.message);
    return { role: 'UNKNOWN', pid: null, port: null, topologyPath: null, args: '', prometheusPort: null };
  }

  const kv = parseKV(out);
  const pid = parseInt(kv.PID || '', 10) || null;
  const args = kv.ARGS || '';
  const promPort = parseInt(kv.PROM_PORT || '', 10) || null;

  if (!pid || !args) {
    console.warn('[node-probe] could not identify cardano-node PID for socket', socket);
    return { role: 'UNKNOWN', pid, port: null, topologyPath: null, args, prometheusPort: promPort };
  }

  const isBp = / --shelley-kes-key /.test(' ' + args + ' ');
  const portMatch    = args.match(/--port\s+(\d+)/);
  const topoMatch    = args.match(/--topology\s+(\S+)/);
  const opCertMatch  = args.match(/--shelley-operational-certificate\s+(\S+)/);

  const result = {
    role: isBp ? 'BP' : 'RELAY',
    pid,
    port: portMatch ? parseInt(portMatch[1], 10) : null,
    topologyPath: topoMatch ? topoMatch[1] : null,
    opCertPath:   opCertMatch ? opCertMatch[1] : null,
    prometheusPort: promPort,
    args,
  };

  console.log(
    `[node-probe] pid=${result.pid} role=${result.role} ` +
    `port=${result.port} prom=${result.prometheusPort || 'off'} ` +
    `topology=${result.topologyPath} ` +
    `opcert=${result.opCertPath || 'none'}`
  );

  return result;
}
