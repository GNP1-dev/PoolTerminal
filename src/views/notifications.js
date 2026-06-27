/**
 * PoolTerminal — NOTIFICATIONS view.
 *
 * A live, colour-coded feed of delegation activity. The signature device is the
 * FLOW: every movement is two ticker pills joined by a marching connector.
 *   • arriving:  OTHER  ▸  GNP1   (home pill GREEN — stake coming in)
 *   • leaving:   GNP1   ▸  OTHER  (home pill RED — stake going out)
 *   • stake change: 91.40 ₳ ▸ 639.97 ₳  (teal up / amber down)
 *
 * Home pool is the ONLY fixed colour: green in / red out, so direction is
 * obvious at a glance for whichever pool runs the app. Other pools get a
 * deterministic colour from their ticker (pool.pm style) and a fixed width so
 * all ticker boxes line up. Each row carries a colour medallion, the amount as
 * a hero number, and a data strip (UTC date/time, epoch, slot, Cardanoscan tx).
 *
 * The list scrolls (rows never compress); refreshes live on pt:notif-events;
 * badges unread when another tab is active. Generic — a new event kind only
 * needs an entry in TYPE.
 */

import { fmtAda, shortStake, getOwnPoolTicker } from '../ui/notif-format.js';
import { getNotifications, clearNotifications } from '../data/read-model.js';

// Copy text to the clipboard with a brief check-mark on the button that fired.
function copyStake(text, btn) {
  const flash = () => {
    if (!btn) return;
    const prev = btn.innerHTML;
    btn.innerHTML = '\u2713 copied';
    btn.classList.add('copied');
    setTimeout(() => { btn.innerHTML = prev; btn.classList.remove('copied'); }, 1100);
  };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(() => fallbackCopy(text, flash));
    } else { fallbackCopy(text, flash); }
  } catch { fallbackCopy(text, flash); }
}
function fallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    done && done();
  } catch (e) { console.warn('[notif] copy failed:', e); }
}

const STYLE_ID = 'pt-notif-view-style';
const BADGE_ID = 'pt-notif-badge';
const FEED_LIMIT = 300;

let mounted = false;
let unread = 0;
let inited = false;

const TYPE = {
  join:              { cls: 'nf-join',  glyph: '+',       title: 'New delegator',       tag: null },
  join_redelegated:  { cls: 'nf-join',  glyph: '+',       title: 'New delegator',       tag: '\u21C4 Transfer' },
  join_returning:    { cls: 'nf-join',  glyph: '\u21BA',  title: 'Returning delegator', tag: '\u21BA Returning' },
  stake_up:          { cls: 'nf-up',    glyph: '\u25B2',  title: 'Stake added',      tag: null },
  stake_down:        { cls: 'nf-down',  glyph: '\u25BC',  title: 'Stake reduced',    tag: null },
  leave_redelegated: { cls: 'nf-leave', glyph: '\u2192',  title: 'Redelegated away', tag: '\u21C4 Transfer' },
  leave_to_wallet:   { cls: 'nf-leave', glyph: '\u2715',  title: 'Undelegated',      tag: null },
  leave:             { cls: 'nf-leave', glyph: '\u2715',  title: 'Left pool',        tag: null },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

function shortPool(p) {
  if (!p) return '\u2014';
  return p.length > 14 ? `${p.slice(0, 7)}\u2026${p.slice(-4)}` : p;
}

/** Deterministic, readable colour for a pool ticker (pool.pm-style variety). */
function tickerColor(label) {
  const s = String(label || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const sat = 52 + (h >> 9) % 16;   // 52-67%
  return `hsl(${hue} ${sat}% 45%)`;
}

function fmtDateTime(ev) {
  let d = null;
  if (ev.detail && ev.detail.time) d = new Date(String(ev.detail.time).replace(' ', 'T') + 'Z');
  else if (ev.capturedAt) d = new Date(ev.capturedAt * 1000);
  if (!d || isNaN(d.getTime())) return '';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()} \u00B7 ${hh}:${mm} UTC`;
}

// --- pills ---
function homePill(label, dir) { // dir: 'in' | 'out'
  return `<span class="nf-pill nf-pill-home nf-home-${dir}">${esc(label)}</span>`;
}
function otherPill(label) {
  return `<span class="nf-pill nf-pill-other" style="background:${tickerColor(label)}">${esc(label)}</span>`;
}
function neutralPill(label) {
  return `<span class="nf-pill nf-pill-neutral">${esc(label)}</span>`;
}
const conn = '<span class="nf-conn"></span>';

function flowHtml(ev) {
  const d = ev.detail || {};
  const own = getOwnPoolTicker() || 'GNP1';
  switch (ev.type) {
    case 'join_redelegated':
      return otherPill(d.fromTicker || shortPool(d.fromPool)) + conn + homePill(own, 'in');
    case 'join_returning':
      return (d.originUncertain
        ? neutralPill('unknown')
        : otherPill(d.fromTicker || shortPool(d.fromPool))) + conn + homePill(own, 'in');
    case 'join':
      return neutralPill('new') + conn + homePill(own, 'in');
    case 'leave_redelegated':
      return homePill(own, 'out') + conn + otherPill(d.toTicker || shortPool(d.toPool));
    case 'leave_to_wallet':
      return homePill(own, 'out') + conn + neutralPill('wallet');
    case 'leave':
      return homePill(own, 'out') + conn + neutralPill('\u2014');
    case 'stake_up':
    case 'stake_down': {
      const after = Number(d.amount || 0);
      const before = after - Number(d.delta || 0);
      return `<span class="nf-bal">${esc(fmtAda(before))}</span>${conn}` +
             `<span class="nf-bal nf-bal-after">${esc(fmtAda(after))}</span>`;
    }
    default:
      return homePill(own, 'in');
  }
}

function amountHtml(ev) {
  const d = ev.detail || {};
  switch (ev.type) {
    case 'join':
      return `<div class="nf-amt-main">${d.amount == null ? '\u2014' : '+' + esc(fmtAda(d.amount))}</div>` +
             `<div class="nf-amt-sub">new stake</div>`;
    case 'join_redelegated':
      return `<div class="nf-amt-main">${d.amount == null ? '\u2014' : '+' + esc(fmtAda(d.amount))}</div>` +
             `<div class="nf-amt-sub">transfer in</div>`;
    case 'join_returning':
      return `<div class="nf-amt-main">${d.amount == null ? '\u2014' : '+' + esc(fmtAda(d.amount))}</div>` +
             `<div class="nf-amt-sub">returning</div>`;
    case 'stake_up':
      return `<div class="nf-amt-main">+${esc(fmtAda(Math.abs(d.delta)))}</div>` +
             `<div class="nf-amt-sub">now ${esc(fmtAda(d.amount))}</div>`;
    case 'stake_down':
      return `<div class="nf-amt-main">\u2212${esc(fmtAda(Math.abs(d.delta)))}</div>` +
             `<div class="nf-amt-sub">now ${esc(fmtAda(d.amount))}</div>`;
    default: // leaves
      return `<div class="nf-amt-main">\u2212${esc(fmtAda(d.amount))}</div>` +
             `<div class="nf-amt-sub">stake lost</div>`;
  }
}

function metaHtml(ev) {
  const d = ev.detail || {};
  const bits = [];
  bits.push(`<span class="nf-stake" title="${esc(ev.stake)}">${esc(shortStake(ev.stake))}</span>` + (ev.stake ? `<button class="nf-copy" type="button" data-copy="${esc(ev.stake)}" title="Copy stake address">\u29C9 copy</button>` : ''));
  const dt = fmtDateTime(ev);
  if (dt) bits.push(`<span class="nf-when">${esc(dt)}</span>`);
  if (d.epoch != null) bits.push(`<span class="nf-ep">epoch ${esc(d.epoch)}</span>`);
  if (d.slot != null) bits.push(`<span>slot ${esc(Number(d.slot).toLocaleString('en-US'))}</span>`);
  if (d.txHash) bits.push(`<span class="nf-tx" data-tx="${esc(d.txHash)}" title="View on Cardanoscan">\u29C9 tx</span>`);
  return bits.join('<span class="nf-sep">\u00B7</span>');
}

function rowHtml(ev, i) {
  const t = TYPE[ev.type] || { cls: 'nf-join', glyph: '\u2022', title: ev.type || 'Change', tag: null };
  const delay = i < 12 ? ` style="animation-delay:${i * 35}ms"` : '';
  // Returning delegator whose true prior pool we can't see on this source: relabel
  // honestly and hint that db-sync resolves the full transfer chain.
  const uncertain = ev.type === 'join_returning' && ev.detail && ev.detail.originUncertain;
  const title = uncertain ? 'Returning Former Delegator' : t.title;
  const tag = uncertain
    ? `<span class="nf-tag nf-tag-hint" title="The intermediate pool isn't visible from the current source. db-sync records every delegation certificate and resolves the full transfer history.">\u21BA Returning \u00b7 connect db-sync for full history</span>`
    : (t.tag ? `<span class="nf-tag">${esc(t.tag)}</span>` : '');
  return (
    `<div class="nf-row ${t.cls}"${delay}>` +
      `<div class="nf-med">${t.glyph}</div>` +
      `<div class="nf-body">` +
        `<div class="nf-titleline"><span class="nf-title">${esc(title)}</span>${tag}</div>` +
        `<div class="nf-flow">${flowHtml(ev)}</div>` +
        `<div class="nf-meta">${metaHtml(ev)}</div>` +
      `</div>` +
      `<div class="nf-amt">${amountHtml(ev)}</div>` +
    `</div>`
  );
}

function summaryHtml(events) {
  let joins = 0, up = 0, down = 0, left = 0;
  for (const e of events) {
    if (e.type === 'join' || e.type === 'join_redelegated' || e.type === 'join_returning') joins++;
    else if (e.type === 'stake_up') up++;
    else if (e.type === 'stake_down') down++;
    else if (e.type && e.type.startsWith('leave')) left++;
  }
  const chip = (cls, label, n) =>
    `<div class="nf-chip ${cls}"><span class="nf-chip-n">${n}</span><span class="nf-chip-l">${label}</span></div>`;
  return (
    `<div class="nf-head">` +
      `<div class="nf-head-titles">` +
        `<div class="nf-h1">Delegation activity</div>` +
        `<div class="nf-h2">Live movements in and out of your pool</div>` +
      `</div>` +
      `<div class="nf-chips">` +
        chip('nf-join', 'joined', joins) +
        chip('nf-up', 'stake +', up) +
        chip('nf-down', 'stake \u2212', down) +
        chip('nf-leave', 'left', left) +
        `<button class="nf-clear" type="button" title="Clear the activity history. Monitoring continues; only the displayed list is wiped.">Clear history</button>` +
      `</div>` +
    `</div>`
  );
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .nf-wrap { padding: 18px 20px 8px; height: 100%; display: flex; flex-direction: column; gap: 14px; box-sizing: border-box; min-height: 0; }

    .nf-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; flex-wrap: wrap; flex: 0 0 auto; }
    .nf-h1 { font-size: 17px; font-weight: 800; letter-spacing: 0.2px; color: var(--pt-text-primary, #e6edf3); }
    .nf-h2 { font-size: 12px; color: var(--pt-text-muted, #9aa7b4); margin-top: 2px; }
    .nf-chips { display: flex; gap: 10px; flex-wrap: wrap; align-items: stretch; }
    .nf-clear { align-self: stretch; padding: 6px 14px; border-radius: 9px; cursor: pointer;
      font: 600 11px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.4px;
      color: var(--pt-text-secondary, #C4CCD8); background: rgba(120,150,180,0.06);
      border: 1px solid rgba(120,150,180,0.25); }
    .nf-clear:hover { color: #ff7a6e; border-color: rgba(232,97,93,0.55); background: rgba(232,97,93,0.10); }
    .nf-clear:disabled { opacity: 0.5; cursor: default; }
    .nf-chip { display: flex; flex-direction: column; align-items: center; min-width: 62px;
      padding: 6px 12px; border-radius: 9px; border: 1px solid var(--nf-edge, rgba(120,150,180,0.2)); background: var(--nf-fill, rgba(120,150,180,0.06)); }
    .nf-chip-n { font-size: 18px; font-weight: 800; line-height: 1; color: var(--nf-acc, #9aa7b4); font-variant-numeric: tabular-nums; }
    .nf-chip-l { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--pt-text-muted, #9aa7b4); margin-top: 4px; }

    /* THE scroll fix: list owns the overflow; rows never shrink. */
    .nf-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px;
      padding: 2px 8px 14px 2px; }
    .nf-list::-webkit-scrollbar { width: 9px; }
    .nf-list::-webkit-scrollbar-thumb { background: rgba(120,150,180,0.28); border-radius: 5px; }

    .nf-row {
      --nf-acc: #4ade80; --nf-acc2: #16a34a; --nf-edge: rgba(74,222,128,0.20); --nf-fill: rgba(74,222,128,0.05);
      flex: 0 0 auto; position: relative; display: flex; align-items: center; gap: 16px;
      padding: 15px 18px 15px 20px; border-radius: 11px;
      background: linear-gradient(180deg, var(--nf-fill), rgba(13,20,28,0.4));
      border: 1px solid var(--nf-edge); overflow: hidden; animation: nf-in 280ms ease both;
    }
    .nf-row::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px;
      background: linear-gradient(180deg, var(--nf-acc), var(--nf-acc2)); }
    .nf-row:hover { border-color: var(--nf-acc); }

    .nf-join  { --nf-acc:#4ade80; --nf-acc2:#16a34a; --nf-edge:rgba(74,222,128,0.22); --nf-fill:rgba(74,222,128,0.06); }
    .nf-up    { --nf-acc:#2dd4bf; --nf-acc2:#0d9488; --nf-edge:rgba(45,212,191,0.22); --nf-fill:rgba(45,212,191,0.06); }
    .nf-down  { --nf-acc:#fbbf24; --nf-acc2:#d97706; --nf-edge:rgba(251,191,36,0.22); --nf-fill:rgba(251,191,36,0.06); }
    .nf-leave { --nf-acc:#fb7185; --nf-acc2:#e11d48; --nf-edge:rgba(251,113,133,0.22); --nf-fill:rgba(251,113,133,0.06); }

    .nf-med { flex: 0 0 38px; width: 38px; height: 38px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: radial-gradient(circle at 32% 28%, var(--nf-acc), var(--nf-acc2));
      color: #07120c; font-size: 16px; font-weight: 900; line-height: 1;
      box-shadow: 0 0 0 1px rgba(255,255,255,0.08), 0 4px 14px -2px var(--nf-acc); }

    .nf-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 7px; }
    .nf-titleline { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
    .nf-title { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.07em; color: var(--nf-acc); }
    .nf-tag-hint { background: rgba(123,176,245,0.12) !important; color: var(--pt-accent-blue-bright, #7BB0F5) !important; text-transform: none !important; letter-spacing: 0.01em !important; font-weight: 600 !important; cursor: help; }
    .nf-tag { font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em;
      padding: 2px 7px; border-radius: 5px; background: var(--nf-acc); color: #07120c; }

    .nf-flow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .nf-pill { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
      min-width: 80px; padding: 4px 12px; border-radius: 13px; font-size: 12px; font-weight: 700;
      letter-spacing: 0.02em; white-space: nowrap; }
    .nf-pill-home { box-shadow: 0 0 0 1px rgba(255,255,255,0.22) inset, 0 2px 10px -3px currentColor; }
    .nf-home-in  { background: #2fd673; color: #06140c; }
    .nf-home-out { background: #f0506a; color: #1a0608; }
    .nf-pill-other { color: #ffffff; border: 1px solid rgba(255,255,255,0.14); text-shadow: 0 1px 2px rgba(0,0,0,0.35); }
    .nf-pill-neutral { background: rgba(150,170,190,0.16); color: var(--pt-text-primary, #e6edf3); border: 1px solid rgba(150,170,190,0.3); }

    .nf-bal { font-size: 12.5px; font-weight: 600; color: var(--pt-text-muted, #9aa7b4); font-variant-numeric: tabular-nums; }
    .nf-bal-after { color: var(--nf-acc); font-weight: 800; }

    .nf-conn { position: relative; flex: 0 0 34px; height: 2px; border-radius: 2px; align-self: center;
      background-image: repeating-linear-gradient(90deg, var(--nf-acc) 0 5px, transparent 5px 10px);
      background-size: 20px 2px; opacity: 0.9; }
    .nf-conn::after { content: '\u25B6'; position: absolute; right: -3px; top: -6px; font-size: 10px; color: var(--nf-acc); }
    @media (prefers-reduced-motion: no-preference) { .nf-conn { animation: nf-march 0.8s linear infinite; } }

    .nf-amt { flex: 0 0 auto; text-align: right; padding-left: 14px; }
    .nf-amt-main { font-size: 19px; font-weight: 800; color: var(--nf-acc); font-variant-numeric: tabular-nums; line-height: 1.1; white-space: nowrap; }
    .nf-amt-sub { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--pt-text-muted, #9aa7b4); margin-top: 3px; }

    .nf-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      font-size: 11px; color: var(--pt-text-muted, #9aa7b4); font-variant-numeric: tabular-nums; }
    .nf-meta .nf-sep { opacity: 0.4; }
    .nf-stake { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: var(--pt-text-primary, #e6edf3); opacity: 0.82; }
    .nf-copy { margin-left: 6px; background: rgba(90,140,220,0.14); border: 1px solid var(--pt-border, #2c3a4d); border-radius: 4px; color: var(--pt-accent-blue, #5a8cdc); cursor: pointer; font: 600 9px ui-monospace, monospace; line-height: 1; padding: 3px 5px; letter-spacing: 0.3px; vertical-align: middle; transition: background 0.12s, color 0.12s; }
    .nf-copy:hover { background: var(--pt-accent-blue, #5a8cdc); color: #fff; }
    .nf-copy.copied { background: var(--pt-accent-gold, #d6b246); color: #1a1205; border-color: var(--pt-accent-gold, #d6b246); }
    .nf-when { color: var(--pt-text-primary, #e6edf3); opacity: 0.9; }
    .nf-ep { color: var(--nf-acc); font-weight: 600; }
    .nf-tx { cursor: pointer; color: var(--nf-acc); border: 1px solid var(--nf-edge); border-radius: 5px; padding: 1px 7px; font-weight: 600; }
    .nf-tx:hover { background: var(--nf-fill); }

    .nf-empty { margin: auto; text-align: center; color: var(--pt-text-muted, #9aa7b4); font-size: 13px; line-height: 1.7; }
    .nf-empty .big { font-size: 30px; display: block; margin-bottom: 10px; opacity: 0.6; }

    @keyframes nf-in { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }
    @keyframes nf-march { to { background-position: 20px 0; } }
    @media (prefers-reduced-motion: reduce) { .nf-row { animation: none; } }
  `;
  document.head.appendChild(style);
}

export function setBadge(n) {
  const b = document.getElementById(BADGE_ID);
  if (!b) return;
  if (n > 0) { b.textContent = n > 99 ? '99+' : String(n); b.style.display = 'inline-block'; }
  else { b.textContent = ''; b.style.display = 'none'; }
}

function ensureBadgeStyle() {
  if (document.getElementById('pt-notif-badge-style')) return;
  const style = document.createElement('style');
  style.id = 'pt-notif-badge-style';
  style.textContent = `
    .pt-tab-badge { display: none; margin-left: 6px; min-width: 16px; height: 16px; padding: 0 5px;
      border-radius: 8px; background: var(--pt-status-bad, #f87171); color: #0b0f14;
      font-size: 10px; font-weight: 700; line-height: 16px; text-align: center; box-sizing: border-box; vertical-align: middle; }
  `;
  document.head.appendChild(style);
}

async function openUrl(url) {
  const T = window.__TAURI__ || {};
  try {
    if (T.opener && T.opener.openUrl) return await T.opener.openUrl(url);
    if (T.shell && T.shell.open) return await T.shell.open(url);
    if (T.core && T.core.invoke) return await T.core.invoke('plugin:opener|open_url', { url });
  } catch (e) { console.warn('[notif] open tx failed:', e.message ?? e); }
  window.open(url, '_blank');
}

async function render(canvas) {
  ensureStyle();
  let events = [];
  try { events = await getNotifications(FEED_LIMIT); }
  catch (e) { console.warn('[notif-view] load failed:', e.message ?? e); }

  const body = events.length
    ? `<div class="nf-list">${events.map(rowHtml).join('')}</div>`
    : `<div class="nf-empty">` +
        `<span class="big">\u{1F50D}</span>No delegation activity yet.<br>` +
        `Joins, transfers and stake changes will appear here the moment they happen on-chain.` +
      `</div>`;

  canvas.innerHTML = `<div class="nf-wrap">${summaryHtml(events)}${body}</div>`;

  const clearBtn = canvas.querySelector('.nf-clear');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      if (!window.confirm('Clear the delegation activity history?\n\nMonitoring continues \u2014 only the displayed list is wiped. New movements will appear from now on.')) return;
      clearBtn.disabled = true; clearBtn.textContent = 'Clearing\u2026';
      await clearNotifications();
      unread = 0; setBadge(0);
      render(canvas);
    });
  }

  const list = canvas.querySelector('.nf-list');
  if (list && !list._txWired) {
    list._txWired = true;
    list.addEventListener('click', (e) => {
      const cp = e.target.closest('[data-copy]');
      if (cp) { e.stopPropagation(); copyStake(cp.getAttribute('data-copy'), cp); return; }
      const el = e.target.closest('[data-tx]');
      if (el) openUrl(`https://cardanoscan.io/transaction/${el.getAttribute('data-tx')}`);
    });
  }
}

export function mountNotifications(canvas) {
  mounted = true;
  unread = 0;
  setBadge(0);
  render(canvas);
}

export function unmountNotifications() {
  mounted = false;
}

export function initNotifications() {
  if (inited) return;
  inited = true;
  ensureBadgeStyle();
  window.addEventListener('pt:notif-events', (e) => {
    const evs = Array.isArray(e.detail) ? e.detail : [];
    if (!evs.length) return;
    if (mounted) {
      const canvas = document.getElementById('pt-canvas');
      if (canvas) render(canvas);
    } else {
      unread += evs.length;
      setBadge(unread);
    }
  });
}
