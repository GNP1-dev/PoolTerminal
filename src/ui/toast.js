/**
 * PoolTerminal — toast notifications.
 *
 * Listens for the `pt:notif-events` window event dispatched by the read-model
 * when a notifications poll emits, and pops a small corner toast per event —
 * regardless of which view/tab is active (the poll runs in the always-on live
 * loop, so this is the cross-tab surface for delegation changes).
 *
 * Toasts are PERSISTENT: they stay until dismissed (× on each, or "Clear all"),
 * so a change can't slip past while you're away from the screen. Clicking a
 * toast body opens the Notifications feed (the durable, full history). A soft
 * cap drops the oldest on-screen toast past MAX_VISIBLE — nothing is lost, the
 * Notifications tab keeps everything.
 *
 * Self-contained: injects its own scoped CSS (design tokens for accents) and its
 * own container, so no markup in index.html and no stylesheet edits. Decoupled
 * from the data layer — it only consumes the event.
 */

import { formatNotifEvent } from './notif-format.js';

const CONTAINER_ID = 'pt-toasts';
const STYLE_ID = 'pt-toast-style';
const MAX_VISIBLE = 8;        // soft cap; oldest dropped past this (feed keeps all)
const SUMMARY_THRESHOLD = 5;  // >this many in one poll -> single summary toast

let initialised = false;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${CONTAINER_ID} {
      position: fixed; top: 64px; right: 16px; z-index: 9999;
      display: flex; flex-direction: column; gap: 8px;
      max-width: 340px; pointer-events: none;
    }
    .pt-toast-clearall {
      pointer-events: auto; cursor: pointer; align-self: flex-end;
      font-size: 10px; letter-spacing: 0.04em; text-transform: uppercase;
      color: var(--pt-text-muted, #9aa7b4);
      background: rgba(13, 20, 28, 0.92);
      border: 1px solid rgba(120, 150, 180, 0.22); border-radius: 4px;
      padding: 3px 8px; user-select: none;
    }
    .pt-toast-clearall:hover { color: var(--pt-text-primary, #e6edf3); }
    .pt-toast {
      pointer-events: auto; cursor: pointer; position: relative;
      background: #1c2735;
      border: 1px solid rgba(120, 150, 180, 0.22);
      border-left: 3px solid var(--pt-accent-blue, #60a5fa);
      border-radius: 6px; padding: 9px 28px 9px 12px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(255, 255, 255, 0.05);
      color: var(--pt-text-primary, #e6edf3);
      animation: pt-toast-in 180ms ease-out;
      transition: opacity 200ms ease, transform 200ms ease;
    }
    .pt-toast.pt-toast-out { opacity: 0; transform: translateX(14px); }
    .pt-toast-pos     { background: rgba(20, 48, 34, 0.99); border-color: rgba(74, 222, 128, 0.45); border-left-color: var(--pt-status-good, #4ade80); }
    .pt-toast-neg     { background: rgba(52, 24, 28, 0.99); border-color: rgba(248, 113, 113, 0.45); border-left-color: var(--pt-status-bad, #f87171); }
    .pt-toast-neutral { background: rgba(22, 40, 60, 0.99); border-color: rgba(96, 165, 250, 0.45); border-left-color: var(--pt-accent-blue, #60a5fa); }
    .pt-toast-head {
      display: flex; align-items: center; gap: 7px;
      font-size: 12px; font-weight: 600; letter-spacing: 0.02em;
    }
    .pt-toast-icon { font-size: 13px; line-height: 1; }
    .pt-toast-line {
      margin-top: 3px; font-size: 11px;
      color: var(--pt-text-muted, #9aa7b4);
      font-variant-numeric: tabular-nums; line-height: 1.35;
    }
    .pt-toast-close {
      position: absolute; top: 5px; right: 7px;
      width: 16px; height: 16px; line-height: 15px; text-align: center;
      font-size: 13px; border-radius: 3px; color: var(--pt-text-muted, #9aa7b4);
      cursor: pointer; user-select: none;
    }
    .pt-toast-close:hover { background: rgba(255,255,255,0.08); color: var(--pt-text-primary, #e6edf3); }
    @keyframes pt-toast-in {
      from { opacity: 0; transform: translateX(16px); }
      to   { opacity: 1; transform: none; }
    }
  `;
  document.head.appendChild(style);
}

function ensureContainer() {
  let c = document.getElementById(CONTAINER_ID);
  if (!c) {
    c = document.createElement('div');
    c.id = CONTAINER_ID;
    document.body.appendChild(c);
  }
  return c;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[<>&"']/g, (ch) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]
  ));
}

function toastEls(c) {
  return Array.from(c.querySelectorAll('.pt-toast'));
}

function refreshClearAll(c) {
  const existing = c.querySelector('.pt-toast-clearall');
  const count = toastEls(c).length;
  if (count >= 2 && !existing) {
    const bar = document.createElement('div');
    bar.className = 'pt-toast-clearall';
    bar.textContent = 'Clear all';
    bar.addEventListener('click', () => {
      toastEls(c).forEach(dismiss);
      bar.remove();
    });
    c.prepend(bar);
  } else if (count < 2 && existing) {
    existing.remove();
  }
}

function dismiss(el) {
  if (!el || el._dismissing) return;
  el._dismissing = true;
  const c = el.parentElement;
  el.classList.add('pt-toast-out');
  setTimeout(() => {
    el.remove();
    if (c) refreshClearAll(c);
  }, 220);
}

function openFeed() {
  const tab = document.querySelector('.pt-tab[data-view="notifications"]');
  if (tab) tab.click();
}

function pushToast({ icon, title, line, tone }) {
  ensureStyle();
  const c = ensureContainer();
  const el = document.createElement('div');
  el.className = `pt-toast pt-toast-${tone || 'neutral'}`;
  el.innerHTML =
    `<span class="pt-toast-close" title="Dismiss">✕</span>` +
    `<div class="pt-toast-head">` +
      `<span class="pt-toast-icon">${icon || '•'}</span>` +
      `<span>${escapeHtml(title)}</span>` +
    `</div>` +
    (line ? `<div class="pt-toast-line">${escapeHtml(line)}</div>` : '');

  el.querySelector('.pt-toast-close').addEventListener('click', (e) => {
    e.stopPropagation();
    dismiss(el);
  });
  el.addEventListener('click', () => { openFeed(); dismiss(el); });

  const bar = c.querySelector('.pt-toast-clearall');
  if (bar) bar.after(el); else c.prepend(el);

  const list = toastEls(c);
  if (list.length > MAX_VISIBLE) dismiss(list[list.length - 1]);

  refreshClearAll(c);
}

function onNotifEvents(e) {
  const events = Array.isArray(e.detail) ? e.detail : [];
  if (!events.length) return;
  if (events.length > SUMMARY_THRESHOLD) {
    pushToast({
      icon: '🔔',
      title: `${events.length} delegator changes`,
      line: 'Click to open Notifications',
      tone: 'neutral',
    });
    return;
  }
  for (const ev of events) pushToast(formatNotifEvent(ev));
}

/** Wire the toast surface. Idempotent; call once from main.js. */
export function initToasts() {
  if (initialised) return;
  initialised = true;
  window.addEventListener('pt:notif-events', onNotifEvents);
}

/** Manual smoke test from the devtools console: `window.__ptToastTest?.()`. */
export function _toastTest() {
  onNotifEvents({ detail: [
    { type: 'stake_down', stake: 'stake1u9c4ch00fa03m9enzy8c6vuy85mra0ltyannzpjugu8vdms6kg7na',
      detail: { amount: 43749651, delta: -14058077, epoch: 636 } },
    { type: 'join_redelegated', stake: 'stake1uxample0000000000000000000000000000000000abcde',
      detail: { amount: 250000000, fromPool: 'pool1abc', fromTicker: 'ADACT', epoch: 636 } },
  ] });
}
