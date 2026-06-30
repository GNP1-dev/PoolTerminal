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
// The progress bar fills on a fixed track equal to the furthest a block can ever
// be: a full epoch (5 days) plus the ~36h before the current epoch ends when the
// next-epoch leadership schedule becomes visible = 6.5 days. So the left edge is
// 6.5 days out (~0%) and the right edge is mint (~100%), and "fullness" always
// means the same closeness. (The old code divided by the live max ETA, which
// shrank every poll and pinned the bar near-empty the whole time.)
const FILL_HORIZON_S = Math.round(6.5 * 24 * 3600);   // 6.5 days = 5d epoch + 36h next-epoch window
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
/* Full d:h:m:s countdown that always shows seconds so it visibly ticks. */
function dhms(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p2 = (x) => String(x).padStart(2, '0');
  if (d > 0) return `${d}d ${p2(h)}h ${p2(m)}m ${p2(sec)}s`;
  if (h > 0) return `${h}h ${p2(m)}m ${p2(sec)}s`;
  if (m > 0) return `${m}m ${p2(sec)}s`;
  return `${sec}s`;
}
/* Bar colour deepens toward red as the mint time approaches. */
function urgencyColour(liveETA) {
  return liveETA < 300   ? '#ff2233'   // < 5 min  deep red
       : liveETA < 3600  ? '#ff4d3a'   // < 1 h    red
       : liveETA < 21600 ? '#ff8a3c'   // < 6 h    orange
       : liveETA < 86400 ? '#ffc24a'   // < 1 d    amber
       :                    '#36e0d4';  // further  teal
}
export function renderUpcomingBlocks(list, opts = {}) {
  polledAt = Date.now() / 1000;
  blocks = list.map((b) => ({
    index:       b.index,
    slot:        b.slot,
    epoch:       b.epoch,
    nextEpoch:   !!b.nextEpoch,
    etaAtPoll:   b.etaSeconds,
    atTimestamp: b.atTimestamp || (Math.floor(polledAt) + b.etaSeconds),
  }));
  maxEtaAtPoll = Math.max(1, ...blocks.map((b) => b.etaAtPoll));
  const body  = byId('ub-body');
  const count = byId('ub-count');
  if (!body || !count) return;

  if (blocks.length === 0) {
    if (opts.isRelay) {
      count.textContent = 'relay';
      body.innerHTML = '<div class="pt-ub-empty">Operating in relay mode only</div>';
    } else if (opts.scheduleState === 'unavailable') {
      count.textContent = 'schedule unavailable';
      body.innerHTML = '<div class="pt-ub-empty">Leadership schedule unavailable. This panel needs <b>cardano-cli query leadership-schedule</b>, which requires the pool\'s VRF signing key and a reachable node socket on this node.</div>';
    } else if (opts.scheduleState === 'loading') {
      count.textContent = 'detecting…';
      body.innerHTML = '<div class="pt-ub-empty">Detecting upcoming blocks…</div>';
    } else {
      count.textContent = 'none upcoming · next epoch shows ~36h before end';
      body.innerHTML = '<div class="pt-ub-empty">No assigned slots this epoch.</div>';
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
      // Horizontal rows, next-to-mint first. Each row:
      //   #Block · progress bar (widens + reddens as mint nears) · d:h:m:s ·
      //   day+time · slot. The body scrolls when there are more than fit.
      body.innerHTML = blocks
        .map((b, i) => {
          const w = formatWhenParts(b.atTimestamp);
          const cls = 'pt-ub-row'
            + (i === 0 ? ' pt-ub-row-next' : '')
            + (b.nextEpoch ? ' pt-ub-row-nx' : '');
          return `
          <div class="${cls}">
            <div class="pt-ub-idx">#${b.index}</div>
            <div class="pt-ub-bar-track"><div class="pt-ub-bar" id="ub-bar-${b.index}" style="width:0%"></div></div>
            <div class="pt-ub-eta" id="ub-eta-${b.index}">${dhms(b.etaAtPoll)}</div>
            <div class="pt-ub-when">${w.day} ${w.time}</div>
            <div class="pt-ub-slot">slot ${commas(b.slot)}</div>
          </div>`;
        })
        .join('');
    }
  }
  if (!rafId) loop();
}
function loop() {
  rafId = requestAnimationFrame(loop);
  if (!blocks.length) return;
  const elapsed   = Date.now() / 1000 - polledAt;
  for (const b of blocks) {
    const liveETA = Math.max(0, b.etaAtPoll - elapsed);
    const etaEl   = byId(`ub-eta-${b.index}`);
    const barEl   = byId(`ub-bar-${b.index}`);
    if (etaEl) etaEl.textContent = dhms(liveETA);
    if (barEl) {
      // fill on a fixed horizon: ~0% a horizon away, ~100% just before mint.
      const fill = Math.min(100, Math.max(0, (1 - liveETA / FILL_HORIZON_S) * 100));
      if (barEl.classList.contains('pt-ub-bar-v')) {
        barEl.style.height = fill.toFixed(1) + '%';
        const c = urgencyColour(liveETA);
        barEl.style.background = c;
        barEl.style.boxShadow = '0 0 10px ' + c + '88';
      } else {
        barEl.style.width = fill.toFixed(1) + '%';
        const c = urgencyColour(liveETA);
        barEl.style.background = c;
        barEl.style.boxShadow = '0 0 8px ' + c + '66';
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
