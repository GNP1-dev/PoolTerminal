/**
 * panel-loader.js — per-panel "waiting for data" spinners for the dashboard.
 *
 * The dashboard mounts instantly with placeholder dashes/zeros, then each panel's
 * data arrives at its own time (block production, chain pulse, mempool, upcoming
 * slots, peers, feed all populate independently and at different speeds). Showing
 * 0/— in the meantime is confusing — it looks like real data.
 *
 * This gives each panel its own spinner overlay: a rotating ring + message,
 * shown until that panel receives its FIRST valid data, then faded out. A panel
 * never shows its numbers until they are real.
 *
 * Usage:
 *   attachPanelLoader(el, 'Waiting for block data');   // on mount
 *   markPanelReady(el);                                // when real data lands
 */

let _styleInjected = false;

function injectStyleOnce() {
  if (_styleInjected) return;
  _styleInjected = true;
  const s = document.createElement('style');
  s.id = 'pt-panel-loader-style';
  s.textContent = `
    .pt-pl {
      position: absolute; inset: 0; z-index: 30;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 10px; padding: 8px; text-align: center;
      background: var(--pt-bg-panel, #12161f);
      border-radius: inherit;
      transition: opacity .35s ease;
    }
    .pt-pl.pt-pl-hide { opacity: 0; pointer-events: none; }
    .pt-pl-ring {
      width: 26px; height: 26px; border: 3px solid rgba(123,176,245,0.22);
      border-top-color: var(--pt-accent-blue-bright, #7BB0F5);
      border-radius: 50%; animation: pt-pl-spin .8s linear infinite;
    }
    @keyframes pt-pl-spin { to { transform: rotate(360deg); } }
    .pt-pl-msg {
      font: 600 10.5px ui-monospace, monospace; letter-spacing: .5px;
      text-transform: uppercase; color: var(--pt-accent-blue-bright, #7BB0F5);
      line-height: 1.35; max-width: 90%;
    }
    .pt-pl-sub {
      font: 10px ui-monospace, monospace; color: var(--pt-text-muted, #97A0B0);
      opacity: .85;
    }
  `;
  document.head.appendChild(s);
}

/**
 * Overlay a loading spinner on a panel element.
 * @param {HTMLElement} el   the panel container (its position is made relative)
 * @param {string} msg       short message under the ring
 * @param {string} [sub]     optional smaller sub-line
 */
export function attachPanelLoader(el, msg, sub) {
  if (!el) return;
  injectStyleOnce();
  // don't double-attach
  let ov = el.querySelector(':scope > .pt-pl');
  if (ov) return ov;
  // the panel must be a positioning context for the absolute overlay
  const pos = getComputedStyle(el).position;
  if (pos === 'static' || !pos) el.style.position = 'relative';
  ov = document.createElement('div');
  ov.className = 'pt-pl';
  ov.innerHTML =
    '<div class="pt-pl-ring"></div>' +
    `<div class="pt-pl-msg">${msg || 'Loading'}</div>` +
    (sub ? `<div class="pt-pl-sub">${sub}</div>` : '');
  el.appendChild(ov);
  return ov;
}

/**
 * Reveal a panel: fade its spinner out and remove it. Safe to call repeatedly;
 * only the first call does anything.
 * @param {HTMLElement} el
 */
export function markPanelReady(el) {
  if (!el) return;
  const ov = el.querySelector(':scope > .pt-pl');
  if (!ov || ov.classList.contains('pt-pl-hide')) return;
  ov.classList.add('pt-pl-hide');
  setTimeout(() => { try { ov.remove(); } catch (e) { /* gone already */ } }, 380);
}

/** True if a panel still has its loader showing (data not yet arrived). */
export function panelIsLoading(el) {
  if (!el) return false;
  const ov = el.querySelector(':scope > .pt-pl');
  return !!ov && !ov.classList.contains('pt-pl-hide');
}
