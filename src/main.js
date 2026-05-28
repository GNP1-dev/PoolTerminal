/**
 * PoolTerminal — entry.
 *
 * Phase 1: always-on poll loop drives the tickertape from getNowSnapshot().
 * The active view's own panels will hook into the same data source as each
 * phase builds them.
 */

import { dataSource, setMode, getMode } from './data/index.js';
import { renderTickertape, markTickertapeStale } from './ui/tickertape.js';

const POLL_INTERVAL_MS = 1000;
let pollTimer = null;
let lastError = null;

async function pollTick() {
  try {
    const snap = await dataSource().getNowSnapshot();
    renderTickertape(snap);
    markTickertapeStale(false);
    lastError = null;
  } catch (e) {
    // Live mode before live.js is implemented throws "not implemented" — show
    // the strip as stale and log only once per error streak (no spam).
    if (e.message !== lastError) {
      console.warn('[poll]', e.message);
      lastError = e.message;
    }
    markTickertapeStale(true);
  }
}

function startPolling() {
  if (pollTimer) return;
  pollTick(); // immediate first paint
  pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('PoolTerminal — Phase 1: tickertape + poll loop');

  // --- Tab switching (placeholder views until each phase builds them) ---
  const tabs = document.querySelectorAll('.pt-tab');
  const canvas = document.getElementById('pt-canvas');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('pt-tab-active'));
      tab.classList.add('pt-tab-active');
      canvas.innerHTML = `
        <div class="pt-placeholder">
          <h2>${tab.textContent} view</h2>
          <p>Built in a later phase.</p>
        </div>`;
    });
  });

  // --- Mode toggle (LIVE / DEMO) ---
  const modeBadge = document.getElementById('ttape-mode');
  function paintMode() {
    const isDemo = getMode() === 'demo';
    modeBadge.classList.toggle('pt-mode-demo', isDemo);
    modeBadge.textContent = isDemo ? '● DEMO' : '● LIVE';
  }
  modeBadge.addEventListener('click', () => {
    setMode(getMode() === 'demo' ? 'live' : 'demo');
    paintMode();
    lastError = null; // let the new mode's first error log once
    pollTick(); // immediate refresh on mode change
  });

  // Default to DEMO until a connection is configured.
  setMode('demo');
  paintMode();
  startPolling();
});
