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
function formatWhenParts(ts) {
  const when = new Date(ts * 1000);
  const now = new Date();
  const time = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
  let day;
  if (sameDay(when, now)) day = 'today';
  else {
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    if (sameDay(when, tomorrow)) day = 'tomorrow';
    else {
      const diffDays = Math.round((when - now) / 86400000);
      day = (diffDays >= 0 && diffDays < 7)
        ? when.toLocaleDateString('en-GB', { weekday: 'short' })
        : when.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
    }
  }
  return { day, time };
}
function whenStackHTML(ts) {
  const p = formatWhenParts(ts);
  return `<div class="pt-ub-col-day">${p.day}</div><div class="pt-ub-col-time">${p.time}</div>`;
}
export function renderUpcomingBlocks(list, opts = {}) {
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
    if (opts.isRelay) {
      count.textContent = 'relay';
      body.innerHTML = '<div class="pt-ub-empty">Operating in relay mode only</div>';
    } else {
      count.textContent = 'none upcoming · next epoch shows ~36h before end';
      body.innerHTML = '<div class="pt-ub-empty">No upcoming assigned slots.</div>';
    }
  } else {
    const nextCount = blocks.filter((b) => b.nextEpoch).length;
    const curCount = blocks.length - nextCount;
    const bits = [];
    if (curCount) bits.push(`${curCount} this epoch`);
    if (nextCount) bits.push(`${nextCount} next epoch`);
    count.textContent = bits.join(' · ');
    if (body.dataset.layout === 'vertical') {
      body.innerHTML = '<div class="pt-ub-vert">' + blocks
        .slice()
        .reverse()
        .map(
          (b) => `
          <div class="pt-ub-col">
            <div class="pt-ub-col-idx">#${b.index}${b.nextEpoch ? ' <span style="color:#f1c40f">ep' + b.epoch + '</span>' : ''}</div>
            <div class="pt-ub-col-track"><div class="pt-ub-col-bar pt-ub-bar-v" id="ub-bar-${b.index}" style="height: 0%"></div></div>
            <div class="pt-ub-col-eta" id="ub-eta-${b.index}">${duration(b.etaAtPoll)}</div>
            ${whenStackHTML(b.atTimestamp)}
          </div>`
        )
        .join('') + '</div>';
      const strip = body.querySelector('.pt-ub-vert');
      if (strip) strip.scrollLeft = strip.scrollWidth;
    } else {
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
      if (barEl.classList.contains('pt-ub-bar-v')) {
        barEl.style.height = fill.toFixed(1) + '%';
        // urgency colour: nearer the block, nearer to red (under a day)
        const c = liveETA < 3600 ? '#ff3344' : liveETA < 21600 ? '#ff7a4c' : liveETA < 86400 ? '#ffc24a' : '#36e0d4';
        barEl.style.background = c;
        barEl.style.boxShadow = '0 0 10px ' + c + '88';
      } else {
        barEl.style.width = fill.toFixed(1) + '%';
      }
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
