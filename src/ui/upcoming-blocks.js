/**
 * PoolTerminal — Upcoming blocks panel.
 *
 * Each row shows:
 *   #idx · slot · wall-clock time · animated progress bar · live ETA
 *
 * The bar's width conveys how close the block is relative to the furthest
 * one in the list: closest (top) has the widest, furthest has the narrowest.
 * Every frame (rAF), bars widen and ETAs count down smoothly.
 *
 * The wall-clock column expects an atTimestamp (Unix epoch seconds). If
 * the data source doesn't provide it, we fall back to "now + etaSeconds".
 */

import { commas, duration } from './format.js';

let blocks = [];
let polledAt = 0;
let maxEtaAtPoll = 1;
let rafId = null;

function byId(id) { return document.getElementById(id); }

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth() &&
         a.getDate()     === b.getDate();
}

function formatWhen(ts) {
  const when = new Date(ts * 1000);
  const now  = new Date();
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  const time = `${hh}:${mm}`;

  if (sameDay(when, now)) return `${time} today`;

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDay(when, tomorrow)) return `${time} tomorrow`;

  const diffDays = Math.round((when - now) / 86400000);
  if (diffDays >= 0 && diffDays < 7) {
    const dayName = when.toLocaleDateString('en-GB', { weekday: 'short' });
    return `${time} ${dayName}`;
  }

  const dateStr = when.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  return `${time} ${dateStr}`;
}

export function renderUpcomingBlocks(list) {
  polledAt = Date.now() / 1000;
  blocks = list.map((b) => ({
    index:       b.index,
    slot:        b.slot,
    etaAtPoll:   b.etaSeconds,
    atTimestamp: b.atTimestamp || (Math.floor(Date.now() / 1000) + b.etaSeconds),
  }));
  maxEtaAtPoll = Math.max(1, ...blocks.map((b) => b.etaAtPoll));

  const body  = byId('ub-body');
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
          <div class="pt-ub-when">${formatWhen(b.atTimestamp)}</div>
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
  const elapsed   = Date.now() / 1000 - polledAt;
  const reference = maxEtaAtPoll * 1.15;
  for (const b of blocks) {
    const liveETA = Math.max(0, b.etaAtPoll - elapsed);
    const etaEl   = byId(`ub-eta-${b.index}`);
    const barEl   = byId(`ub-bar-${b.index}`);
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
