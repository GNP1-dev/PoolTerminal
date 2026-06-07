/**
 * PoolTerminal — Upcoming blocks panel.
 *
 * Each row shows:
 *   #idx · slot · wall-clock time · epoch tag · animated progress bar · live ETA
 *
 * Shows assigned leader slots still to come, spanning the CURRENT epoch
 * (remaining slots) and the NEXT epoch once the ~36h leadership-schedule window
 * is open. Next-epoch slots are tagged so they're clearly distinguished.
 *
 * The bar's width conveys how close the block is relative to the furthest
 * one in the list. Every frame (rAF), bars widen and ETAs count down smoothly.
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
    epoch:       b.epoch,
    nextEpoch:   !!b.nextEpoch,
    etaAtPoll:   b.etaSeconds,
    atTimestamp: b.atTimestamp || (Math.floor(Date.now() / 1000) + b.etaSeconds),
  }));
  maxEtaAtPoll = Math.max(1, ...blocks.map((b) => b.etaAtPoll));
  const body  = byId('ub-body');
  const count = byId('ub-count');
  if (!body || !count) return;

  if (blocks.length === 0) {
    count.textContent = 'none upcoming';
    body.innerHTML = '<div class="pt-ub-empty">No upcoming assigned slots.</div>';
  } else {
    const nextCount = blocks.filter((b) => b.nextEpoch).length;
    const curCount = blocks.length - nextCount;
    const bits = [];
    if (curCount) bits.push(`${curCount} this epoch`);
    if (nextCount) bits.push(`${nextCount} next epoch`);
    count.textContent = bits.join(' · ');
    body.innerHTML = blocks
      .map(
        (b, i) => `
        <div class="pt-ub-row${i === 0 ? ' pt-ub-row-next' : ''}">
          <div class="pt-ub-idx">#${b.index}</div>
          <div class="pt-ub-when">${formatWhen(b.atTimestamp)}</div>
          <div class="pt-ub-slot">slot ${commas(b.slot)}</div>
          <div class="pt-ub-epoch" style="font-size:10px;opacity:.7;${b.nextEpoch ? 'color:#f1c40f;' : ''}">${b.nextEpoch ? 'ep ' + b.epoch : 'this ep'}</div>
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
