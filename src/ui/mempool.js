/**
 * PoolTerminal — Mempool panel.
 * Lists pending transactions seen on the local node. Per-poll re-render only;
 * no countdowns or flashes — mempool churn is fast enough that flash would
 * just be noise.
 */

import { commas } from './format.js';

function byId(id) { return document.getElementById(id); }
function setText(id, v) { const el = byId(id); if (el) el.textContent = v; }

function fmtBytes(b) {
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

export function renderMempool(mp) {
  setText(
    'mp-count',
    mp.txCount === 0 ? 'empty' : `${mp.txCount} tx · ${fmtBytes(mp.totalBytes)}`
  );

  const body = byId('mp-body');
  if (!body) return;

  if (mp.recent.length === 0) {
    body.innerHTML = '<div class="pt-mp-empty">No pending transactions.</div>';
  } else {
    body.innerHTML = mp.recent
      .map(
        (tx) => `
        <div class="pt-mp-row">
          <div class="pt-mp-hash"><span class="pt-muted">tx ·</span> ${tx.hash}</div>
          <div class="pt-mp-size">${commas(tx.bytes)} B</div>
        </div>`
      )
      .join('');
  }
}
