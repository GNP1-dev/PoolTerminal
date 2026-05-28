/**
 * PoolTerminal — entry.
 *
 * Phase 1: always-on poll loop drives the tickertape (global chrome) and, when
 * the NOW tab is active, the NOW view's panels. Other views mount placeholders
 * until their phase.
 */

import { dataSource, setMode, getMode } from './data/index.js';
import { renderTickertape, markTickertapeStale } from './ui/tickertape.js';
import { mountNow, updateNow } from './views/now.js';

const POLL_INTERVAL_MS = 1000;
let pollTimer = null;
let lastError = null;
let activeView = 'now';
let canvasEl = null;

function labelFor(view) {
  return { 'node-health': 'Node health' }[view] || view.charAt(0).toUpperCase() + view.slice(1);
}

function mountView(view) {
  activeView = view;
  if (view === 'now') {
    mountNow(canvasEl);
  } else {
    canvasEl.innerHTML = `
      <div class="pt-placeholder">
        <h2>${labelFor(view)} view</h2>
        <p>Built in a later phase.</p>
      </div>`;
  }
}

async function pollTick() {
  try {
    const snap = await dataSource().getNowSnapshot();
    renderTickertape(snap);
    if (activeView === 'now') updateNow(snap);
    markTickertapeStale(false);
    lastError = null;
  } catch (e) {
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
  console.log('PoolTerminal — Phase 1: NOW hero row');
  canvasEl = document.getElementById('pt-canvas');

  // --- Tabs ---
  const tabs = document.querySelectorAll('.pt-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('pt-tab-active'));
      tab.classList.add('pt-tab-active');
      mountView(tab.dataset.view);
      if (activeView === 'now') pollTick(); // fill immediately on entering NOW
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
    lastError = null;
    pollTick();
  });

  // Default to DEMO; mount NOW (default active tab); start polling.
  setMode('demo');
  paintMode();
  mountView('now');
  startPolling();
});
