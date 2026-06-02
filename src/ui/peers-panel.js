/**
 * PoolTerminal — Peers panel.
 *
 * Header (when Prometheus available):  OUT 60 · IN 12 · BiDir 80 · Duplex 5
 * Header (fallback when not):          N sockets
 *
 * Body: peer list from `ss`, one row per established TCP connection,
 *       sorted by RTT (fastest first). RTT is colour-coded:
 *       < 50 ms   = green
 *       < 150 ms  = amber
 *       >= 150 ms = red
 *
 * Per-peer direction is intentionally omitted: in P2P mode the kernel
 * socket info cannot distinguish whom-dialed-whom because cardano-node
 * binds outbound connections to its listen port (SO_REUSEPORT). The
 * accurate direction breakdown is shown in the header from Prometheus.
 */

function byId(id) { return document.getElementById(id); }

function setText(id, text) {
  const el = byId(id);
  if (el) el.textContent = text;
}

function formatRtt(rtt) {
  if (rtt == null) return '—';
  if (rtt < 1) return '<1ms';
  if (rtt < 1000) return Math.round(rtt) + 'ms';
  return (rtt / 1000).toFixed(1) + 's';
}

function rttClass(rtt) {
  if (rtt == null) return 'pt-rtt-unknown';
  if (rtt < 50)  return 'pt-rtt-good';
  if (rtt < 150) return 'pt-rtt-warn';
  return 'pt-rtt-bad';
}

function rowHtml(peer) {
  return (
    `<div class="pt-pp-row">` +
      `<span class="pt-pp-ip">${peer.ip}:${peer.port}</span>` +
      `<span class="pt-pp-rtt ${rttClass(peer.rtt)}">${formatRtt(peer.rtt)}</span>` +
    `</div>`
  );
}

function fmt(v) { return v == null ? '—' : v; }

function paintHeader(peerData) {
  const m = peerData && peerData.metrics;
  if (m) {
    setText('pp-out',    fmt(m.outgoingConns));
    setText('pp-in',     fmt(m.incomingConns));
    setText('pp-bidir',  fmt(m.duplexConns));
    setText('pp-duplex', fmt(m.prunableConns));
  } else {
    // Fallback when Prometheus is disabled on this node
    const total = peerData ? peerData.total : null;
    setText('pp-out',    '—');
    setText('pp-in',     '—');
    setText('pp-bidir',  '—');
    setText('pp-duplex', total != null ? String(total) : '—');
  }
}

export function renderPeersPanel(peerData) {
  const body = byId('pp-body');
  if (!body) return;

  if (!peerData) {
    body.innerHTML = '<div class="pt-pp-empty">No peer data yet…</div>';
    paintHeader(null);
    return;
  }

  paintHeader(peerData);

  if (!peerData.total) {
    body.innerHTML = '<div class="pt-pp-empty">No peers connected.</div>';
    return;
  }

  body.innerHTML = peerData.peers.map(rowHtml).join('');
}

export function resetPeersPanel() {
  renderPeersPanel(null);
}
