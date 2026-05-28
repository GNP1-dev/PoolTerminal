/**
 * PoolTerminal — entry.
 *
 * Phase 0: chrome shell + data router wired. The NOW view (Phase 1) will consume
 * dataSource() on a poll loop and render real panels; for now we prove the
 * contract end-to-end by logging a demo snapshot.
 */

import { dataSource, setMode, getMode } from './data/index.js';

// eslint-disable-next-line no-unused-vars
const { invoke } = window.__TAURI__.core;

window.addEventListener('DOMContentLoaded', async () => {
  console.log('PoolTerminal — Phase 0 ready');

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
          <p>Phase 0 placeholder — built in a later phase.</p>
        </div>`;
    });
  });

  // --- Mode toggle (LIVE / DEMO) wired to the data router ---
  const modeBadge = document.getElementById('ttape-mode');
  function paintMode() {
    const isDemo = getMode() === 'demo';
    modeBadge.classList.toggle('pt-mode-demo', isDemo);
    modeBadge.textContent = isDemo ? '● DEMO' : '● LIVE';
  }
  modeBadge.addEventListener('click', () => {
    setMode(getMode() === 'demo' ? 'live' : 'demo');
    paintMode();
    console.log('[mode]', getMode());
  });

  // Default to DEMO until a connection is configured.
  setMode('demo');
  paintMode();

  // --- Phase 0 proof: verify the contract round-trips in the webview ---
  try {
    const src = dataSource();
    console.log('[data] identity:', await src.getPoolIdentity());
    console.log('[data] NowSnapshot:', await src.getNowSnapshot());
    console.log('[data] ChainPulse:', await src.getChainPulse());
    console.log('[data] UpcomingBlocks:', await src.getUpcomingBlocks());
    console.log('[data] Mempool:', await src.getMempool());
  } catch (e) {
    console.error('[data] proof failed:', e);
  }
});
