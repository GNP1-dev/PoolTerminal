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
import { renderPeersPanel, resetPeersPanel } from './ui/peers-panel.js';
import { renderRelayMap, resetRelayMap } from './ui/relay-map.js';
import {
  mountNow, updateNowFast, bootstrapNow, refreshMempool, refreshUpcomingBlocks, unmountNow,
} from './views/now.js';
import { mountHistory } from './views/history.js';
import { mountNodeHealth, unmountNodeHealth } from './views/node-health.js';
import { mountMap, unmountMap, isMapMounted, updateMapPeers } from './views/map.js';
import { mountDelegators, unmountDelegators } from './views/delegators.js';
import { showConnectModal } from './views/connect.js';
import { nodeExec } from './data/tauri.js';
import { getSession, setNodeProbe, getNodeProbe } from './data/session.js';
import { probeNode } from './data/node-probe.js';
import { queryPeers } from './data/peers-query.js';
import { initToasts } from './ui/toast.js';
import { initNotifications, mountNotifications, unmountNotifications } from './views/notifications.js';
import { setOwnPoolTicker } from './ui/notif-format.js';

const FAST_INTERVAL_MS = 1000;
const MEMPOOL_REFRESH_EVERY_S = 5;
const PEERS_REFRESH_EVERY_S = 5;
const UPCOMING_REFRESH_EVERY_S = 60;

let fastTimer = null;
let fastPolling = false;
let lastFastError = null;
let fastCount = 0;
let latestSnap = null;
let lastSeenBlock = null;
let lastPollTime = null;
let lastMempoolRefreshTime = 0;
let lastPeersRefreshTime = 0;
let lastUpcomingRefreshTime = 0;
let bootstrapStarted = false;

let activeView = 'now';
let canvasEl = null;

function labelFor(view) {
  return { 'node-health': 'Node health' }[view] || view.charAt(0).toUpperCase() + view.slice(1);
}

function mountView(view) {
  const isHealth = view === 'health' || view === 'node-health';
  if (activeView === 'now' && view !== 'now') unmountNow();
  if ((activeView === 'health' || activeView === 'node-health') && !isHealth) unmountNodeHealth();
  if (activeView === "map" && view !== "map") unmountMap();
  if (activeView === 'notifications' && view !== 'notifications') unmountNotifications();
  activeView = view;
  if (view === 'now') {
    mountNow(canvasEl);
    refreshUpcomingBlocks(dataSource()).catch(() => {});
  } else if (view === 'history') {
    mountHistory(canvasEl);
  } else if (isHealth) {
    mountNodeHealth(canvasEl);
  } else if (view === 'map') {
    mountMap(canvasEl);
  } else if (view === 'delegators') {
    mountDelegators(canvasEl);
  } else if (view === 'notifications') {
    mountNotifications(canvasEl);
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
    if (snap.poolTicker) setOwnPoolTicker(snap.poolTicker);
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
      refreshMempool(dataSource(), latestSnap?.tipBlock).catch((e) =>
        console.warn('[mempool refresh] FAIL:', e.message)
      );
    }

    // Upcoming-blocks refresh every minute — leadership schedule changes only
    // once per epoch in practice; we still re-poll for the new "next epoch"
    // schedule once the safe window opens.
    if (activeView === 'now' && nowSec - lastUpcomingRefreshTime >= UPCOMING_REFRESH_EVERY_S) {
      lastUpcomingRefreshTime = nowSec;
      refreshUpcomingBlocks(dataSource()).catch((e) =>
        console.warn('[upcoming refresh] FAIL:', e.message)
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
        if (isMapMounted()) updateMapPeers(r.peers);
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

/** Read the connected node's cardano-node version once per connect.
 *  cardano-node and cardano-cli now version separately, so we must run the
 *  node binary itself — and it isn't on PATH in a non-interactive SSH shell.
 *  Most reliable source: the actual running process via /proc/<pid>/exe (the
 *  probe already found the node's PID). Falls back to the Guild env CCLI path
 *  and finally a bare PATH lookup. */
async function execOut(cmd) {
  const r = await nodeExec(cmd);
  return (typeof r === 'string' ? r : (r && r.stdout) || '').trim();
}

async function fetchNodeVersion() {
  const probe = getNodeProbe && getNodeProbe();
  const s = getSession();
  const ccli = s.envVars && s.envVars.CCLI;

  const candidates = [];
  // 1) The running node binary, located by process match — proven to work and
  //    independent of PATH (binary isn't on PATH in non-interactive SSH).
  candidates.push(`"$(readlink -f /proc/$(pgrep -f 'cardano-node run' | head -1)/exe)" --version`);
  // 2) The exact probed PID, if available.
  if (probe && probe.pid) candidates.push(`"$(readlink -f /proc/${probe.pid}/exe)" --version`);
  // 3) Derive from the Guild env CCLI path; 4) bare PATH.
  if (ccli) candidates.push(`"${ccli.replace(/\/[^/]+$/, '')}/cardano-node" --version`);
  candidates.push('cardano-node --version');

  for (const cmd of candidates) {
    try {
      const out = await execOut(cmd);
      const m = out.match(/cardano-node\s+(\S+)/i);
      if (m) return m[1];
    } catch { /* next candidate */ }
  }
  return null;
}

async function paintNodeVersion() {
  const el = document.getElementById('ttape-nodever');
  if (!el) return;
  if (getMode() !== 'live') { el.textContent = ''; el.style.display = 'none'; return; }
  try {
    const v = await fetchNodeVersion();
    if (v) { el.textContent = `node v${v}`; el.style.display = ''; }
    else { el.style.display = 'none'; }
  } catch { el.style.display = 'none'; }
}

async function runProbeAndPaintRole() {
  if (getMode() !== 'live') {
    setRoleBadge(null);
    paintNodeVersion();
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
  paintNodeVersion();
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('PoolTerminal — Phase 3 (1s fast loop, cncli bootstrap-only)');
  canvasEl = document.getElementById('pt-canvas');

  // Cross-tab notification toasts (listens for pt:notif-events from read-model).
  initToasts();
  initNotifications();   // unread badge + live feed refresh
  import('./ui/toast.js').then((m) => { window.__ptToastTest = m._toastTest; }).catch(() => {});
  import('./data/dbsync-query.js').then((m) => {
    window.__ptDelegEvents = (o) => m.getDelegationEvents(o).then((r) => { console.table(r.events || r); return r; });
  }).catch(() => {});

  window.__pt_ssh = async (cmd) => {
    const r = await nodeExec(cmd);
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

  // Branding link → open in the system browser. A bare <a target="_blank"> is
  // swallowed by the Tauri webview, so route through whichever opener is present.
  const brand = document.querySelector('.pt-ticker-brand');
  if (brand) {
    brand.style.cursor = 'pointer';
    brand.addEventListener('click', async (e) => {
      e.preventDefault();
      const url = brand.getAttribute('href');
      const T = window.__TAURI__ || {};
      try {
        if (T.opener?.openUrl) return await T.opener.openUrl(url);
        if (T.shell?.open) return await T.shell.open(url);
        if (T.core?.invoke) return await T.core.invoke('plugin:opener|open_url', { url });
      } catch (err) {
        console.warn('[brand] opener failed, falling back:', err.message ?? err);
      }
      window.open(url, '_blank');   // last resort
    });
  }

  const modeBadge = document.getElementById('ttape-mode');
  modeBadge.addEventListener('click', () => {
    showConnectModal(() => {
      paintMode();
      lastFastError = null;
      lastSeenBlock = null;
      lastPollTime = null;
      lastMempoolRefreshTime = 0;
      lastPeersRefreshTime = 0;
      lastUpcomingRefreshTime = 0;
      bootstrapStarted = false;
      setPeerCounts(null, null);
      resetPeersPanel();
      resetRelayMap();
      if (activeView === 'now') mountNow(canvasEl);
      runProbeAndPaintRole();
      fastPollTick();
    });
  });

  setMode('demo');
  paintMode();
  setRoleBadge(null);
  mountView('now');

  showConnectModal((result) => {
    mountView('now');
    paintMode();
    runProbeAndPaintRole();
    startPolling();
  });
});
