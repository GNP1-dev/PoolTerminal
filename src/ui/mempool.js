/**
 * PoolTerminal — Mempool panel.
 * Per-poll re-render; no flashes.
 *
 * Header gauge shows current mempool fill as a percentage of one block's
 * capacity (mainnet maxBlockBodySize, ~88 KiB). The scale runs 0..300% with
 * tick markers at the 100% and 200% (one- and two-block) boundaries.
 *
 * Colour:
 *   <100%  : green — next block clears everything
 *   100-200%: amber — will take ~2 blocks to clear
 *   >200%  : red   — significant congestion (3+ blocks)
 *
 * When wiring live data, MAX_BLOCK_BODY should be read from
 * `cardano-cli query protocol-parameters` rather than hardcoded.
 */

import { commas } from './format.js';

const MAX_BLOCK_BODY = 90112; // bytes
const MAX_SCALE = 300;        // gauge scale extends to 300%

function byId(id) { return document.getElementById(id); }

function fmtBytes(b) {
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

function colorsFor(pct) {
  if (pct < 100)  return { fill: 'var(--pt-status-good)', txt: 'var(--pt-text-primary)' };
  if (pct < 200)  return { fill: 'var(--pt-status-warn)', txt: 'var(--pt-status-warn)' };
  return            { fill: 'var(--pt-status-bad)',  txt: 'var(--pt-status-bad)'  };
}

export function renderMempool(mp) {
  const countEl = byId('mp-count');
  if (!countEl) return;

  const pct = (mp.totalBytes / MAX_BLOCK_BODY) * 100;
  const trackPct = Math.min((pct / MAX_SCALE) * 100, 100);
  const { fill, txt } = colorsFor(pct);

  const left = mp.txCount === 0 ? 'empty' : `${mp.txCount} tx · ${fmtBytes(mp.totalBytes)}`;

  countEl.innerHTML = `
    <span class="pt-muted">${left}</span>
    <span class="pt-mp-gauge">
      <span class="pt-mp-gauge-track">
        <span class="pt-mp-gauge-fill" style="width:${trackPct.toFixed(1)}%; background:${fill};"></span>
      </span>
      <span class="pt-mp-gauge-pct" style="color:${txt};">${Math.round(pct)}%</span>
    </span>`;

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
