/**
 * PoolTerminal — entry.
 *
 * Phase 1: always-on poll loop drives the tickertape (global chrome) and, when
 * the NOW tab is active, the NOW view's panels (hero row + chain pulse).
 */

import { dataSource, setMode, getMode } from './data/index.js';
import { renderTickertape, markTickertapeStale } from './ui/tickertape.js';
import { mountNow, updateNow, unmountNow } from './views/now.js';

const POLL_INTERVAL_MS = 1000;
let pollTimer = null;
let lastError = null;
let activeView = 'now';
let canvasEl = null;

function labelFor(view) {
  return { 'node-health': 'Node health' }[view] || view.charAt(0).toUpperCase() + view.slice(1);
}

function mountView(view) {
  if (activeView === 'now' && view !== 'now') unmountNow();
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
    const src = dataSource();
    const snap = await src.getNowSnapshot();
    renderTickertape(snap);
    markTickertapeStale(false);
    lastError = null;
    if (activeView === 'now') await updateNow(src, snap);
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
  pollTick();
  pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('PoolTerminal — Phase 1: NOW (hero + chain pulse)');
  canvasEl = document.getElementById('pt-canvas');

  const tabs = document.querySelectorAll('.pt-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('pt-tab-active'));
      tab.classList.add('pt-tab-active');
      mountView(tab.dataset.view);
      if (activeView === 'now') pollTick();
    });
  });

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

  setMode('demo');
  paintMode();
  mountView('now');
  startPolling();
});
