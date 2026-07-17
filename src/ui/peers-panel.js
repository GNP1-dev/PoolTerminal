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

// Per-peer RTT history, keyed by ip:port, so we can draw a latency trend under
// each peer. Kept in memory (last N samples). Because BP peer latencies are
// tiny (1-8ms), the sparkline auto-scales to each peer's OWN recent min/max so
// small millisecond changes are visible rather than flattened.
const RTT_HIST = new Map();
const RTT_HIST_MAX = 60;   // samples kept per peer (~ minutes at 5s poll)

function pushRtt(key, rtt) {
  if (rtt == null) return;
  let arr = RTT_HIST.get(key);
  if (!arr) { arr = []; RTT_HIST.set(key, arr); }
  arr.push(rtt);
  if (arr.length > RTT_HIST_MAX) arr.shift();
}

function rttSparkline(hist) {
  if (!hist || hist.length < 2) return '<div class="pt-pp-spark pt-pp-spark-empty">building trend…</div>';
  const W = 240, H = 22, pad = 2;
  const min = Math.min(...hist), max = Math.max(...hist);
  // Adaptive scale: if the range is tiny, pad it a touch so a flat line sits
  // mid-height rather than hugging an edge, but keep small wiggles visible.
  const span = Math.max(0.5, max - min);
  const lo = min - span * 0.15, hi = max + span * 0.15;
  const rng = hi - lo || 1;
  const stepX = (W - pad * 2) / (hist.length - 1);
  const pts = hist.map((v, i) => {
    const x = pad + i * stepX;
    const y = H - pad - ((v - lo) / rng) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const last = hist[hist.length - 1];
  const col = last < 50 ? 'var(--pt-status-good,#5dff9b)' : last < 150 ? 'var(--pt-status-warn,#ffc24a)' : 'var(--pt-status-bad,#ff5a3c)';
  return `<svg class="pt-pp-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1"/>` +
    `</svg>` +
    `<span class="pt-pp-range">${formatRtt(min)}\u2013${formatRtt(max)}</span>`;
}

function rowHtml(peer, idx) {
  const key = `${peer.ip}:${peer.port}`;
  const hist = RTT_HIST.get(key) || [];
  return (
    `<div class="pt-pp-row2">` +
      `<div class="pt-pp-line">` +
        `<span class="pt-pp-num">#${idx + 1}</span>` +
        `<span class="pt-pp-ip">${peer.ip}:${peer.port}</span>` +
        `<span class="pt-pp-rtt ${rttClass(peer.rtt)}">${formatRtt(peer.rtt)}</span>` +
      `</div>` +
      `<div class="pt-pp-trend">${rttSparkline(hist)}</div>` +
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

  // record this poll's RTT for each peer before drawing the trends
  peerData.peers.forEach((pr) => pushRtt(`${pr.ip}:${pr.port}`, pr.rtt));
  body.innerHTML = peerData.peers.map((pr, i) => rowHtml(pr, i)).join('');
}

export function resetPeersPanel() {
  renderPeersPanel(null);
}
