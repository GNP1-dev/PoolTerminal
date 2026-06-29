/**
 * PoolTerminal — Prometheus metrics query.
 *
 * Scrapes cardano-node's Prometheus exposition endpoint via SSH (the
 * endpoint listens on 127.0.0.1, so SSH-to-node is the natural transport).
 *
 * Only enabled when node-probe found a Prometheus listener for our PID.
 *
 * gLiveView uses exactly these metrics for its IN/OUT/BiDir/Duplex display:
 *   connectionManager_incomingConns       — IN
 *   connectionManager_outgoingConns       — OUT
 *   connectionManager_unidirectionalConns — Uni-Dir
 *   connectionManager_duplexConns         — Bi-Dir
 *   connectionManager_prunableConns       — Duplex
 *   peerSelection_{cold,warm,hot}         — outbound peer state
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

let lastMetrics = null;
export function getLastMetrics() { return lastMetrics; }
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

  const result = {
    incomingConns:        readMetric(out, 'cardano_node_metrics_connectionManager_inboundConns_int'),
    outgoingConns:        readMetric(out, 'cardano_node_metrics_connectionManager_outboundConns_int'),
    unidirectionalConns:  readMetric(out, 'cardano_node_metrics_connectionManager_unidirectionalConns_int'),
    duplexConns:          readMetric(out, 'cardano_node_metrics_connectionManager_duplexConns_int'),
    prunableConns:        readMetric(out, 'cardano_node_metrics_connectionManager_fullDuplexConns_int'),
    peersCold:            readMetric(out, 'cardano_node_metrics_peerSelection_Cold_int'),
    peersWarm:            readMetric(out, 'cardano_node_metrics_peerSelection_Warm_int'),
    peersHot:             readMetric(out, 'cardano_node_metrics_peerSelection_Hot_int'),
    // Used by the mempool panel for throughput (delta between successive reads).
    // cardano-node 11.0.1 renamed this from _int to _counter (it's cumulative).
    txsProcessed:         readMetric(out, 'cardano_node_metrics_txsProcessedNum_counter'),

    // --- NODE HEALTH fields (same scrape, no extra cost) ---
    rssBytes:             readMetric(out, 'cardano_node_metrics_Mem_resident_int'),     // process RSS
    gcLiveBytes:          readMetric(out, 'cardano_node_metrics_RTS_gcLiveBytes_int'),  // live heap
    gcHeapBytes:          readMetric(out, 'cardano_node_metrics_RTS_gcHeapBytes_int'),  // heap reserved
    cpuTicks:             readMetric(out, 'cardano_node_metrics_Stat_cputicks_int'),    // cumulative; rate in-code
    density:              readMetric(out, 'cardano_node_metrics_density_real'),         // chain density
    slotNum:              readMetric(out, 'cardano_node_metrics_slotNum_int'),
    blockNum:             readMetric(out, 'cardano_node_metrics_blockNum_int'),
    mempoolBytes:         readMetric(out, 'cardano_node_metrics_mempoolBytes_int'),
    mempoolTxs:           readMetric(out, 'cardano_node_metrics_txsInMempool_int'),
    blocksForged:         readMetric(out, 'cardano_node_metrics_blocksForged_int'),     // BP: blocks made
    cannotForge:          readMetric(out, 'cardano_node_metrics_nodeCannotForge_int'),  // BP: forge failures
    slotsMissed:          readMetric(out, 'cardano_node_metrics_slotsMissed_int'),      // BP: missed leader slots

    // --- BLOCK PROPAGATION (gLiveView-style) ---
    blockDelayCdfOne:     readMetric(out, 'cardano_node_metrics_blockfetchclient_blockdelay_cdfOne_real'),   // frac <1s
    blockDelayCdfThree:   readMetric(out, 'cardano_node_metrics_blockfetchclient_blockdelay_cdfThree_real'), // frac <3s
    blockDelayCdfFive:    readMetric(out, 'cardano_node_metrics_blockfetchclient_blockdelay_cdfFive_real'),  // frac <5s
    blockDelayLast:       readMetric(out, 'cardano_node_metrics_blockfetchclient_blockdelay_real'),          // last block delay (s)
  };

  lastMetrics = result;

  console.log(
    `[metrics] ${Math.round(performance.now() - t0)}ms · ` +
    `OUT ${result.outgoingConns} · IN ${result.incomingConns} · ` +
    `BiDir ${result.duplexConns} · Duplex ${result.prunableConns}`
  );

  return result;
}
