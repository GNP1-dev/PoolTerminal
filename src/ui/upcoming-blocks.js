/**
 * PoolTerminal — Upcoming blocks panel.
 * Scrollable list of this epoch's remaining assigned slots. Each row's ETA
 * counts down every second via requestAnimationFrame — no extra polling.
 *
 * The list itself only updates when the poll delivers new data (block adopted,
 * epoch rollover, etc.). Between polls, only the countdowns tick.
 */

import { commas, duration } from './format.js';

let blocks = [];      // [{ index, slot, etaAtPollSec }]
let polledAt = 0;     // unix seconds when the current list was received
let rafId = null;

function byId(id) { return document.getElementById(id); }

export function renderUpcomingBlocks(list) {
  polledAt = Date.now() / 1000;
  blocks = list.map((b) => ({
    index: b.index,
    slot: b.slot,
    etaAtPoll: b.etaSeconds, // ETA reported at this poll's instant
  }));

  const body = byId('ub-body');
  const count = byId('ub-count');
  if (!body || !count) return;

  count.textContent = blocks.length === 0
    ? 'no blocks left'
    : `${blocks.length} left this epoch`;

  if (blocks.length === 0) {
    body.innerHTML = '<div class="pt-ub-empty">No remaining assigned slots.</div>';
  } else {
    body.innerHTML = blocks
      .map(
        (b, i) => `
        <div class="pt-ub-row${i === 0 ? ' pt-ub-row-next' : ''}">
          <div class="pt-ub-idx">#${b.index}</div>
          <div class="pt-ub-slot">slot ${commas(b.slot)}</div>
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
  for (const b of blocks) {
    const el = byId(`ub-eta-${b.index}`);
    if (!el) continue;
    const remaining = Math.max(0, b.etaAtPoll - elapsed);
    el.textContent = duration(remaining);
  }
}

export function stopUpcomingBlocks() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
  blocks = [];
  polledAt = 0;
}
