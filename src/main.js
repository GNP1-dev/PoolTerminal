/**
 * PoolTerminal — entry.
 *
 * Polling architecture (gLiveView-style):
 *   - Fast loop (1s)  : cardano-cli query tip via SSH (~50ms, local socket).
 *                       Drives tickertape, hero cards, block detection.
 *                       Every 5s also refreshes mempool (~110ms).
 *   - Bootstrap (1x)  : cncli sqlite + initial mempool, runs ONCE in the
 *                       background after first connect. Populates the
 *                       heartbeat with last hour of historical blocks.
 *                       Never repeated.
 *
 * After bootstrap, the heartbeat is fed entirely by real-time observations
 * from the fast loop (tip.block increments → appendTick). cncli is never
 * queried again unless the user reconnects.
 *
 * BP load steady-state: ~1 tip query/sec + 1 mempool/5s ≈ 1.2 SSH cmd/sec.
 * Comparable to gLiveView; both use the local Unix socket for tip.
 */

import { dataSource, setMode, getMode } from './data/index.js';
import { renderTickertape, markTickertapeStale, setRoleBadge, setPeerCounts } from './ui/tickertape.js';
import { appendTick as appendChainPulseTick } from './ui/chain-pulse.js';
import { renderPeersPanel } from './ui/peers-panel.js';
import { renderRelayMap } from './ui/relay-map.js';
import {
  mountNow, updateNowFast, bootstrapNow, refreshMempool, unmountNow,
} from './views/now.js';
import { showConnectModal } from './views/connect.js';
import { getSession, setNodeProbe } from './data/session.js';
import { probeNode } from './data/node-probe.js';
import { queryPeers } from './data/peers-query.js';

const FAST_INTERVAL_MS = 1000;
const MEMPOOL_REFRESH_EVERY_S = 5;
const PEERS_REFRESH_EVERY_S = 5;

let fastTimer = null;
let fastPolling = false;
let lastFastError = null;
let fastCount = 0;
let latestSnap = null;
let lastSeenBlock = null;
let lastPollTime = null;
let lastMempoolRefreshTime = 0;
let lastPeersRefreshTime = 0;
let bootstrapStarted = false;

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

async function bootstrap() {
  if (bootstrapStarted) return;
  bootstrapStarted = true;
  try {
    const src = dataSource();
    console.log('[bootstrap] cncli + mempool (background, ~30s)');
    const t0 = performance.now();
    await bootstrapNow(src);
    console.log(`[bootstrap] OK in ${Math.round(performance.now() - t0)}ms`);
  } catch (e) {
    console.warn('[bootstrap] FAIL:', e.message);
  }
}

async function fastPollTick() {
  if (fastPolling) return;
  fastPolling = true;
  fastCount++;
  const ctx = `[fast #${fastCount}]`;
  const nowSec = Math.floor(Date.now() / 1000);
  try {
    const src = dataSource();
    const snap = await src.getNowSnapshot();
    renderTickertape(snap);
    markTickertapeStale(false);
    const firstSnap = !latestSnap;
    latestSnap = snap;
    lastFastError = null;

    if (activeView === 'now') {
      updateNowFast(snap);
    }

    // Detect new blocks via tip.block increment. Spread synthetic ticks across
    // the interval since the previous fast poll so they render at distinct x
    // positions instead of stacking at the right edge.
    if (snap.tipBlock != null) {
      if (lastSeenBlock != null && snap.tipBlock > lastSeenBlock) {
        const delta = snap.tipBlock - lastSeenBlock;
        const T0 = lastPollTime != null ? lastPollTime : nowSec;
        const T1 = nowSec;
        const span = Math.max(0, T1 - T0);
        console.log(`${ctx} block ${lastSeenBlock} → ${snap.tipBlock} (+${delta}, span=${span}s)`);
        for (let i = 1; i <= delta; i++) {
          const t = span > 0 ? T0 + Math.round(span * i / delta) : nowSec;
          appendChainPulseTick(t);
        }
      }
      lastSeenBlock = snap.tipBlock;
    }
    lastPollTime = nowSec;

    // Mempool refresh every Nth second (background, doesn't gate this tick).
    if (activeView === 'now' && nowSec - lastMempoolRefreshTime >= MEMPOOL_REFRESH_EVERY_S) {
      lastMempoolRefreshTime = nowSec;
      refreshMempool(dataSource()).catch((e) =>
        console.warn('[mempool refresh] FAIL:', e.message)
      );
    }

    // Peers refresh every Nth second (live mode only; demo paints via snap).
    if (getMode() === 'live' && nowSec - lastPeersRefreshTime >= PEERS_REFRESH_EVERY_S) {
      lastPeersRefreshTime = nowSec;
      queryPeers().then((r) => {
        if (!r) return;
        if (r.metrics) {
          setPeerCounts(r.metrics.outgoingConns, r.metrics.incomingConns);
        } else {
          setPeerCounts(r.total, 0);
        }
        renderPeersPanel(r);
        renderRelayMap(r.peers);
      }).catch((e) =>
        console.warn('[peers refresh] FAIL:', e.message)
      );
    }

    // Kick off one-time bootstrap after first snap (background task).
    if (firstSnap) bootstrap();
  } catch (e) {
    if (e.message !== lastFastError) {
      console.warn(`${ctx} FAIL:`, e.message);
      lastFastError = e.message;
    }
    markTickertapeStale(true);
  } finally {
    fastPolling = false;
  }
}

function startPolling() {
  if (fastTimer) return;
  fastPollTick();
  fastTimer = setInterval(fastPollTick, FAST_INTERVAL_MS);
}

function paintMode() {
  const modeBadge = document.getElementById('ttape-mode');
  const isDemo = getMode() === 'demo';
  modeBadge.classList.toggle('pt-mode-demo', isDemo);
  if (isDemo) {
    modeBadge.textContent = '● DEMO';
  } else {
    const s = getSession();
    modeBadge.textContent = `● LIVE · ${s.host || '—'}`;
  }
}

async function runProbeAndPaintRole() {
  if (getMode() !== 'live') {
    setRoleBadge(null);
    return;
  }
  try {
    const probe = await probeNode();
    setNodeProbe(probe);
    setRoleBadge(probe.role);
  } catch (e) {
    console.warn('[probe] FAIL:', e.message);
    setRoleBadge('UNKNOWN');
  }
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('PoolTerminal — Phase 3 (1s fast loop, cncli bootstrap-only)');
  canvasEl = document.getElementById('pt-canvas');

  window.__pt_ssh = async (cmd) => {
    const r = await window.__TAURI__.core.invoke('ssh_run', { command: cmd });
    return typeof r === 'string' ? r : r.stdout;
  };

  const tabs = document.querySelectorAll('.pt-tab');
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('pt-tab-active'));
      tab.classList.add('pt-tab-active');
      mountView(tab.dataset.view);
    });
  });

  const modeBadge = document.getElementById('ttape-mode');
  modeBadge.addEventListener('click', () => {
    showConnectModal(() => {
      paintMode();
      lastFastError = null;
      lastSeenBlock = null;
      lastPollTime = null;
      lastMempoolRefreshTime = 0;
      lastPeersRefreshTime = 0;
      bootstrapStarted = false;
      setPeerCounts(null, null);
      runProbeAndPaintRole();
      fastPollTick();
    });
  });

  setMode('demo');
  paintMode();
  setRoleBadge(null);
  mountView('now');

  showConnectModal((result) => {
    paintMode();
    runProbeAndPaintRole();
    startPolling();
  });
});
