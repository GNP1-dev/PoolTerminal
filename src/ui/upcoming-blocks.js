/**
 * PoolTerminal — Upcoming blocks panel.
 *
 * Each row shows a horizontal progress bar whose WIDTH conveys how close that
 * block is to arriving, relative to the furthest block in the list:
 *   width = (1 - liveETA / referenceETA) * 100%
 * So the closest block (top) has the widest bar; the furthest block has the
 * narrowest. As time elapses, every bar widens smoothly via rAF.
 *
 * Reference ETA is the longest ETA + 15% headroom, so even the furthest block
 * shows a small bar (rather than empty), and there's room for new blocks that
 * land beyond the current max.
 */

import { commas, duration } from './format.js';

let blocks = [];
let polledAt = 0;
let maxEtaAtPoll = 1;
let rafId = null;

function byId(id) { return document.getElementById(id); }

export function renderUpcomingBlocks(list) {
  polledAt = Date.now() / 1000;
  blocks = list.map((b) => ({
    index: b.index,
    slot: b.slot,
    etaAtPoll: b.etaSeconds,
  }));
  maxEtaAtPoll = Math.max(1, ...blocks.map((b) => b.etaAtPoll));

  const body = byId('ub-body');
  const count = byId('ub-count');
  if (!body || !count) return;

  count.textContent =
    blocks.length === 0 ? 'no blocks left' : `${blocks.length} left this epoch`;

  if (blocks.length === 0) {
    body.innerHTML = '<div class="pt-ub-empty">No remaining assigned slots.</div>';
  } else {
    body.innerHTML = blocks
      .map(
        (b, i) => `
        <div class="pt-ub-row${i === 0 ? ' pt-ub-row-next' : ''}">
          <div class="pt-ub-idx">#${b.index}</div>
          <div class="pt-ub-slot">slot ${commas(b.slot)}</div>
          <div class="pt-ub-bar-track">
            <div class="pt-ub-bar" id="ub-bar-${b.index}" style="width: 0%"></div>
          </div>
          <div class="pt-ub-eta" id="ub-eta-${b.index}">${duration(b.etaAtPoll)}</div>
        </div>`
      )
      .join('');
  }

  if (!rafId) loop();
}

function loop() {
  rafId = requestAnimationFrame(loop);
  if (!blocks.length) return;
  const elapsed = Date.now() / 1000 - polledAt;
  const reference = maxEtaAtPoll * 1.15;
  for (const b of blocks) {
    const liveETA = Math.max(0, b.etaAtPoll - elapsed);
    const etaEl = byId(`ub-eta-${b.index}`);
    const barEl = byId(`ub-bar-${b.index}`);
    if (etaEl) etaEl.textContent = duration(liveETA);
    if (barEl) {
      const fill = Math.min(100, Math.max(0, (1 - liveETA / reference) * 100));
      barEl.style.width = fill.toFixed(1) + '%';
    }
  }
}

export function stopUpcomingBlocks() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  blocks = [];
  polledAt = 0;
  maxEtaAtPoll = 1;
}
