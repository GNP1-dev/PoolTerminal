/**
 * PoolTerminal — Relay monitor probe.
 *
 * Self-contained, live-only health probe for a relay node. Reads ONLY from the
 * relay's own cardano-node: it auto-discovers the process, its node port and
 * Prometheus port, then scrapes that Prometheus endpoint. No Koios, db-sync,
 * Blockfrost, or cache is touched — nothing here is shared with the BP view.
 *
 * Transport is per-relay:
 *   mode 'ssh'   — runs over an independent relay SSH session (relay_ssh_run),
 *                  keyed by relay id, held alongside the BP session.
 *   mode 'local' — runs on this machine (local_run), for a relay on this box.
 *
 * The Prometheus scrape runs ON the relay against 127.0.0.1, so a localhost-only
 * metrics endpoint (the usual hardening) is reached fine.
 */

import { invoke } from './tauri.js';

// ---- transport -------------------------------------------------------------

/** Run a shell command on the relay, via its SSH session or locally. */
async function relayRun(id, mode, command) {
  const r =
    mode === 'local'
      ? await invoke('local_run', { command })
      : await invoke('relay_ssh_run', { id, command });
  if (typeof r === 'string') return r;
  return r?.stdout ?? '';
}

/** Public passthrough so the map can geolocate over the relay's own egress. */
export function relayExec(id, mode, command) { return relayRun(id, mode, command); }

/** Open the relay's SSH session. params mirrors the BP ConnectParams shape. */
export async function relayConnect(id, params) {
  return invoke('relay_ssh_connect', { id, params });
}

/** Close and drop the relay's SSH session. Safe to call when not connected. */
export async function relayDisconnect(id) {
  try { return await invoke('relay_ssh_disconnect', { id }); }
  catch { return null; }
}

/** True if a relay SSH session is currently held for this id. */
export async function relayIsConnected(id) {
  try { return await invoke('relay_ssh_is_connected', { id }); }
  catch { return false; }
}

// ---- probe -----------------------------------------------------------------

function parseKV(out) {
  const kv = {};
  out.split('\n').forEach((line) => {
    const eq = line.indexOf('=');
    if (eq > 0) kv[line.slice(0, eq).trim()] = line.slice(eq + 1);
  });
  return kv;
}

// Per-relay discovered node facts, cached after the first successful probe so
// the poll loop only re-scrapes metrics (cheap) rather than re-discovering.
const _probeCache = new Map();   // id -> probe result
const _selectors = new Map();    // id -> selector substring (config / IP / port) or ''
export function getRelayProbe(id) { return _probeCache.get(id) || null; }
export function clearRelayProbe(id) { _probeCache.delete(id); }
/** Set the node selector for a relay (config substring, bind IP, or port). */
export function setRelaySelector(id, sel) { _selectors.set(id, (sel || '').trim()); }

// Pull "cnode_relay" (or similar) out of a --config path for a readable label.
function configLabel(args) {
  const m = (args || '').match(/--config[= ]+(\S+)/);
  if (!m) return null;
  const cn = m[1].match(/\/([^/]*cnode[^/]*)\//);
  if (cn) return cn[1];
  const parts = m[1].split('/').filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : (parts[0] || null);
}
function hostAddrOf(args) {
  const m = (args || '').match(/--host-addr[= ]+(\S+)/);
  return m ? m[1] : null;
}

/**
 * Discover the relay's cardano-node, selecting the right one when a host runs
 * more than one (e.g. a co-located BP + relay on a dual-NIC box). Enumerates
 * EVERY cardano-node, then chooses by: (1) an explicit selector substring if
 * set (matched against args / config / bind IP / port), else (2) the node with
 * no KES key — the relay — when several are present, else (3) the only node.
 * Returns ports + a config label + role + a candidate summary for the UI.
 */
export async function relayProbe(id, mode) {
  const cmd =
    `for PID in $(pgrep -x cardano-node 2>/dev/null); do ` +
    `ARGS=$(ps -p "$PID" -o args= 2>/dev/null); ` +
    `NP=$(echo "$ARGS" | grep -oP -- '--port[= ]+\\K[0-9]+'); ` +
    `PP=$(ss -tlnp 2>/dev/null | grep "pid=$PID," | awk '{print $4}' | awk -F: '{print $NF}' | grep -v "^$NP$" | head -1); ` +
    `ET=$(ps -o etimes= -p "$PID" 2>/dev/null | tr -d ' '); ` +
    `KES=$(echo "$ARGS" | grep -c -- '--shelley-kes-key'); ` +
    `BIN=$(echo "$ARGS" | awk '{print $1}'); ` +
    `VER=$("$BIN" --version 2>/dev/null | head -1); ` +
    `echo "@@NODE@@"; echo "PID=$PID"; echo "ARGS=$ARGS"; echo "NODE_PORT=$NP"; ` +
    `echo "PROM_PORT=$PP"; echo "ETIMES=$ET"; echo "KES=$KES"; echo "VER=$VER"; ` +
    `done`;

  let out;
  try {
    out = await relayRun(id, mode, cmd);
  } catch (err) {
    return { ok: false, reason: 'unreachable', error: err?.message ?? String(err) };
  }

  const candidates = [];
  for (const block of out.split('@@NODE@@')) {
    if (!block.includes('PID=')) continue;
    const kv = parseKV(block);
    const pid = parseInt(kv.PID || '', 10) || null;
    if (!pid) continue;
    const args = (kv.ARGS || '').trim();
    const etimes = parseInt(kv.ETIMES || '', 10);
    let version = (kv.VER || '').trim() || null;
    const vm = version && version.match(/cardano-node\s+(\S+)/);
    if (vm) version = vm[1];
    candidates.push({
      pid,
      args,
      nodePort: parseInt(kv.NODE_PORT || '', 10) || null,
      prometheusPort: parseInt(kv.PROM_PORT || '', 10) || null,
      nodeStartUnix: Number.isFinite(etimes) && etimes > 0 ? Math.floor(Date.now() / 1000) - etimes : null,
      kes: parseInt(kv.KES || '0', 10) || 0,
      version,
      config: configLabel(args),
      hostAddr: hostAddrOf(args),
    });
  }
  if (!candidates.length) return { ok: false, reason: 'no-node' };

  const summarize = (c) => ({ pid: c.pid, config: c.config, nodePort: c.nodePort, hostAddr: c.hostAddr, role: c.kes > 0 ? 'BP' : 'RELAY' });
  const sel = (_selectors.get(id) || '').trim();
  let chosen, selection = null;
  if (sel) {
    chosen = candidates.find((c) =>
      (c.args && c.args.includes(sel)) ||
      (c.config && c.config.includes(sel)) ||
      (c.hostAddr && c.hostAddr.includes(sel)) ||
      String(c.nodePort) === sel || String(c.prometheusPort) === sel);
    if (!chosen) {
      return {
        ok: false, reason: 'no-match',
        detail: `No cardano-node on this host matched "${sel}".`,
        candidates: candidates.map(summarize),
      };
    }
    selection = 'selector';
  } else if (candidates.length > 1) {
    const relays = candidates.filter((c) => c.kes === 0);
    chosen = relays[0] || candidates[0];
    selection = relays.length ? 'auto-relay' : 'auto-first';
  } else {
    chosen = candidates[0];
  }

  const probe = {
    ok: true,
    pid: chosen.pid,
    nodePort: chosen.nodePort,
    prometheusPort: chosen.prometheusPort,
    nodeStartUnix: chosen.nodeStartUnix,
    version: chosen.version,
    role: chosen.kes > 0 ? 'BP' : 'RELAY',
    hasPrometheus: !!chosen.prometheusPort,
    config: chosen.config,
    hostAddr: chosen.hostAddr,
    nodeCount: candidates.length,
    selection,
    candidates: candidates.length > 1 ? candidates.map(summarize) : null,
  };
  _probeCache.set(id, probe);
  return probe;
}

// ---- metrics ---------------------------------------------------------------

function readMetric(text, name) {
  const re = new RegExp(`^${name}\\s+([\\d.eE+\\-]+)`, 'm');
  const m = text.match(re);
  return m ? parseFloat(m[1]) : null;
}

/**
 * Scrape the relay's Prometheus endpoint and return the health subset a relay
 * card shows: pulse (tip/slot/density), peer counts, mempool, memory. Returns
 * { ok:false } with a reason when there's nothing to scrape.
 */
export async function relayHealth(id, mode, probe) {
  const p = probe || _probeCache.get(id);
  if (!p || !p.ok) return { ok: false, reason: 'no-node' };
  if (!p.prometheusPort) return { ok: false, reason: 'no-prometheus' };

  let out;
  try {
    out = await relayRun(
      id,
      mode,
      `curl -sf --max-time 3 http://127.0.0.1:${p.prometheusPort}/metrics 2>/dev/null`,
    );
  } catch (err) {
    return { ok: false, reason: 'scrape-failed', error: err?.message ?? String(err) };
  }
  if (!out || !out.trim()) return { ok: false, reason: 'scrape-empty' };

  const inbound  = readMetric(out, 'cardano_node_metrics_connectionManager_inboundConns_int');
  const outbound = readMetric(out, 'cardano_node_metrics_connectionManager_outboundConns_int');
  const duplex   = readMetric(out, 'cardano_node_metrics_connectionManager_duplexConns_int');

  return {
    ok: true,
    blockNum:    readMetric(out, 'cardano_node_metrics_blockNum_int'),
    slotNum:     readMetric(out, 'cardano_node_metrics_slotNum_int'),
    epoch:       readMetric(out, 'cardano_node_metrics_epoch_int'),
    slotInEpoch: readMetric(out, 'cardano_node_metrics_slotInEpoch_int'),
    density:     readMetric(out, 'cardano_node_metrics_density_real'),
    inbound,
    outbound,
    duplex,
    peersCold:   readMetric(out, 'cardano_node_metrics_peerSelection_Cold_int'),
    peersWarm:   readMetric(out, 'cardano_node_metrics_peerSelection_Warm_int'),
    peersHot:    readMetric(out, 'cardano_node_metrics_peerSelection_Hot_int'),
    mempoolTxs:  readMetric(out, 'cardano_node_metrics_txsInMempool_int'),
    mempoolBytes:readMetric(out, 'cardano_node_metrics_mempoolBytes_int'),
    rssBytes:    readMetric(out, 'cardano_node_metrics_Mem_resident_int'),
    blockDelayCdf1: readMetric(out, 'cardano_node_metrics_blockfetchclient_blockdelay_cdfOne_real'),
    blockDelayCdf3: readMetric(out, 'cardano_node_metrics_blockfetchclient_blockdelay_cdfThree_real'),
    blockDelayCdf5: readMetric(out, 'cardano_node_metrics_blockfetchclient_blockdelay_cdfFive_real'),
    blockDelayLast: readMetric(out, 'cardano_node_metrics_blockfetchclient_blockdelay_real'),
    ts: Date.now(),
  };
}

/**
 * One-shot convenience for the poll loop: ensure we have a probe (discover once
 * and cache), then scrape metrics. Re-probes automatically if the cache is empty
 * (e.g. first call, or after the node restarted and was cleared).
 */
// ---- peer scan (ss -tnpi, like the BP's peers-query) -----------------------
// cardano-node P2P uses SO_REUSEPORT, so ss can't reliably split inbound from
// outbound; we return one RTT-sorted list (the header counts come from
// Prometheus). Mirrors src/data/peers-query.js.
function _parseAddrPair(line) {
  const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)/g;
  const m1 = re.exec(line); if (!m1) return null;
  const m2 = re.exec(line); if (!m2) return null;
  return { localIp: m1[1], localPort: +m1[2], remoteIp: m2[1], remotePort: +m2[2] };
}
function _parseRtt(line) {
  if (!line) return null;
  const m = line.match(/\srtt:([\d.]+)\//);
  return m ? parseFloat(m[1]) : null;
}
export async function relayPeers(id, mode, probe) {
  if (!probe || !probe.pid) return { peers: [], total: 0 };
  let out;
  try { out = await relayRun(id, mode, `ss -tnpi state established 2>/dev/null`); }
  catch (err) { console.warn(`[relay ${id}] peer scan failed:`, err?.message); return { peers: [], total: 0 }; }

  const peers = [];
  const pidTag = `pid=${probe.pid},`;
  const lines = out.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(pidTag)) continue;
    const p = _parseAddrPair(line);
    if (!p) continue;
    if (p.remoteIp === '127.0.0.1' || p.localIp === '127.0.0.1' || p.remoteIp === '0.0.0.0') continue;
    let rtt = null;
    if (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) rtt = _parseRtt(lines[i + 1]);
    peers.push({ ip: p.remoteIp, port: p.remotePort, localPort: p.localPort, rtt });
  }
  peers.sort((a, b) => {
    if (a.rtt == null && b.rtt == null) return 0;
    if (a.rtt == null) return 1;
    if (b.rtt == null) return -1;
    return a.rtt - b.rtt;
  });
  return { peers, total: peers.length };
}

export async function relaySnapshot(id, mode) {
  let probe = _probeCache.get(id);
  if (!probe || !probe.ok) probe = await relayProbe(id, mode);
  if (!probe.ok) return { probe, health: { ok: false, reason: probe.reason }, peers: [] };
  const [health, peerData] = await Promise.all([
    relayHealth(id, mode, probe),
    relayPeers(id, mode, probe),
  ]);
  return { probe, health, peers: peerData.peers };
}
