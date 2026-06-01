/**
 * PoolTerminal — Peers panel.
 *
 * Renders the live peer list from peers-query into the NOW view. Each row
 * shows direction arrow, remote IP:port, and the kernel's smoothed RTT.
 *
 * Sorted outbound-first (peers WE chose), then inbound; within each group
 * fastest peers (lowest RTT) first.
 *
 * Phase 2 (later): geo (ip-api.com batch) and AS in their own columns.
 * Phase 3 (later): BiDir / Duplex breakdown from Prometheus metrics.
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

function rowHtml(peer, dir) {
  const arrow = dir === 'in' ? '↓' : '↑';
  return (
    `<div class="pt-pp-row pt-pp-dir-${dir}">` +
      `<span class="pt-pp-dir">${arrow}</span>` +
      `<span class="pt-pp-ip">${peer.ip}:${peer.port}</span>` +
      `<span class="pt-pp-rtt">${formatRtt(peer.rtt)}</span>` +
    `</div>`
  );
}

export function renderPeersPanel(peerData) {
  const body = byId('pp-body');
  if (!body) return;

  if (!peerData) {
    body.innerHTML = '<div class="pt-pp-empty">No peer data yet…</div>';
    setText('pp-total', '—');
    setText('pp-in', '—');
    setText('pp-out', '—');
    return;
  }

  const { inbound = [], outbound = [], total = 0 } = peerData;
  setText('pp-total', total);
  setText('pp-in', inbound.length);
  setText('pp-out', outbound.length);

  if (total === 0) {
    body.innerHTML = '<div class="pt-pp-empty">No peers connected.</div>';
    return;
  }

  const rows = [
    ...outbound.map((p) => rowHtml(p, 'out')),
    ...inbound.map((p) => rowHtml(p, 'in')),
  ];
  body.innerHTML = rows.join('');
}

export function resetPeersPanel() {
  renderPeersPanel(null);
}
