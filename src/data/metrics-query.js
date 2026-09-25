/**
 * PoolTerminal — Prometheus metrics query.
 *
 * Scrapes cardano-node's Prometheus exposition endpoint via SSH (the
 * endpoint listens on 127.0.0.1, so SSH-to-node is the natural transport).
 *
 * Only enabled when node-probe found a Prometheus listener for our PID.
 *
 * The IN/OUT/BiDir/Duplex display reads the new-tracing connection-manager
 * metrics (names as emitted by node 11.0.1 and 11.1.2, prefix detected per
 * scrape - see metricReader):
 *   connectionManager_inboundConns_int        — IN
 *   connectionManager_outboundConns_int       — OUT
 *   connectionManager_unidirectionalConns_int — Uni-Dir
 *   connectionManager_duplexConns_int         — Bi-Dir
 *   connectionManager_fullDuplexConns_int     — Duplex
 *   peerSelection_{Cold,Warm,Hot}_int         — outbound peer state
 * (connectionManager_prunableConns, named in older docs, is never emitted.)
 *
 * The gLiveView docs note: in P2P mode the *direction of a specific peer*
 * is not discoverable from socket info — only these aggregate counts are
 * authoritative. So we use these for the panel header, and the ss-based
 * peer list for the body (rows show RTT only, no per-row direction in P2P).
 */

import { invoke } from './tauri.js';
import { getNodeProbe } from './session.js';

async function runCmd(command) {
  const r = await invoke('ssh_run', { command });
  if (typeof r === 'string') return r;
  return r?.stdout ?? '';
}

function readMetric(text, name) {
  const re = new RegExp(`^${name}\\s+([\\d.eE+\\-]+)`, 'm');
  const m = text.match(re);
  return m ? parseFloat(m[1]) : null;
}

// Metric names are <prefix><name>, where the prefix comes from the node's
// TraceOptionMetricsPrefix (Guild/upstream: "cardano.node.metrics." ->
// cardano_node_metrics_). Hard-coding it meant a custom prefix left every panel
// silently empty. Detect it per scrape from the blockNum line; fall back to the
// stock prefix. Shared with relay-probe.js. /*metrics-prefix-v1*/
const STOCK_PREFIX = 'cardano_node_metrics_';
export function detectMetricsPrefix(text) {
  const m = text.match(/^([A-Za-z0-9_:]*?)blockNum_int\s/m);
  return m ? m[1] : STOCK_PREFIX;
}
/** A reader for one scrape: rm('blockNum_int') -> number | null. */
export function metricReader(text) {
  const prefix = detectMetricsPrefix(text);
  return (name) => readMetric(text, prefix + name);
}

let lastMetrics = null;
// Demo isolation: the last scrape is REAL node metrics — never paint it in
// demo. The synthetic stand-in omits mempoolBytes/blockDelay* on purpose, so
// now2's mempool-flow and propagation panels fall through to their own demo
// fallbacks. /*demo-world-v99*/
import { getMode } from './index.js';
import { demoNodeMetrics } from './demo-world.js';
export function getLastMetrics() {
  try { if (getMode() === 'demo') return demoNodeMetrics(); } catch { /* fall through */ }
  return lastMetrics;
}
export function clearLastMetrics() { lastMetrics = null; }

export async function queryMetrics() {
  const probe = getNodeProbe();
  if (!probe || !probe.prometheusPort) return null;

  const t0 = performance.now();
  const cmd =
    `curl -sf --max-time 3 http://127.0.0.1:${probe.prometheusPort}/metrics 2>/dev/null`;

  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[metrics] SSH failure:', err.message);
    return null;
  }
  if (!out || !out.trim()) return null;

  const rm = metricReader(out);
  const result = {
    incomingConns:        rm('connectionManager_inboundConns_int'),
    outgoingConns:        rm('connectionManager_outboundConns_int'),
    unidirectionalConns:  rm('connectionManager_unidirectionalConns_int'),
    duplexConns:          rm('connectionManager_duplexConns_int'),
    prunableConns:        rm('connectionManager_fullDuplexConns_int'),
    peersCold:            rm('peerSelection_Cold_int'),
    peersWarm:            rm('peerSelection_Warm_int'),
    peersHot:             rm('peerSelection_Hot_int'),
    // Used by the mempool panel for throughput (delta between successive reads).
    // cardano-node 11.0.1 renamed this from _int to _counter (it's cumulative).
    txsProcessed:         rm('txsProcessedNum_counter'),

    // --- NODE HEALTH fields (same scrape, no extra cost) ---
    rssBytes:             rm('Mem_resident_int'),     // process RSS
    gcLiveBytes:          rm('RTS_gcLiveBytes_int'),  // live heap
    gcHeapBytes:          rm('RTS_gcHeapBytes_int'),  // heap reserved
    cpuTicks:             rm('Stat_cputicks_int'),    // cumulative; rate in-code
    density:              rm('density_real'),         // chain density
    slotNum:              rm('slotNum_int'),
    blockNum:             rm('blockNum_int'),
    mempoolBytes:         rm('mempoolBytes_int'),
    mempoolTxs:           rm('txsInMempool_int'),
    blocksForged:         rm('blocksForged_int'),     // BP: blocks minted
    cannotForge:          rm('nodeCannotForge_int'),  // BP: forge failures (a real fault)
    nodeIsLeader:         rm('nodeIsLeader_int'),     // BP: times scheduled to mint
    // NOT missed blocks. This counts slots where the forge loop did not run its
    // leadership check in time (busy CPU, IO, GC pause) — the same counter
    // gLiveView shows as "missed slot leader checks". The node was almost never
    // leader for those slots. Only meaningful against aboutToLead, below.
    slotsMissed:          rm('slotsMissed_int'),      // BP: LATE leader checks
    // Denominator for slotsMissed: leadership checks the node set out to run.
    // /*forge-honesty-v107*/
    aboutToLead:          rm('Forge_about_to_lead_counter'),

    // --- BLOCK PROPAGATION (gLiveView-style) ---
    blockDelayCdfOne:     rm('blockfetchclient_blockdelay_cdfOne_real'),   // frac <1s
    blockDelayCdfThree:   rm('blockfetchclient_blockdelay_cdfThree_real'), // frac <3s
    blockDelayCdfFive:    rm('blockfetchclient_blockdelay_cdfFive_real'),  // frac <5s
    blockDelayLast:       rm('blockfetchclient_blockdelay_real'),          // last block delay (s)
  };

  lastMetrics = result;

  console.log(
    `[metrics] ${Math.round(performance.now() - t0)}ms · ` +
    `OUT ${result.outgoingConns} · IN ${result.incomingConns} · ` +
    `BiDir ${result.duplexConns} · Duplex ${result.prunableConns}`
  );

  return result;
}
