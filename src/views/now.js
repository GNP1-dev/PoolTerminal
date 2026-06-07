/**
 * PoolTerminal — NOW view.
 *
 * Layout (fills viewport height):
 *   hero row (8 cards): Epoch · Pulse · KES · Ideal · Leader · Adopt · Confirmed · Lost
 *   chain pulse (full width; large "since last block" readout)
 *   bottom grid (3-col, Relay Map spans both rows; bottom grid flex-fills):
 *     row 1: Mempool   | Peers   | Relay Map
 *     row 2: Upcoming Blocks (2 cols)        | Relay Map (continues)
 */

import { renderHero, resetHero } from '../ui/now-hero.js';
import {
  renderChainPulse,
  initChainPulse,
  setChainPulseStatus,
  stopChainPulse,
} from '../ui/chain-pulse.js';
import { renderUpcomingBlocks, stopUpcomingBlocks } from '../ui/upcoming-blocks.js';
import { renderMempool } from '../ui/mempool.js';
import { renderRelayMap, initRelayMap } from '../ui/relay-map.js';
import { renderPeersPanel, resetPeersPanel } from '../ui/peers-panel.js';
import { getNodeProbe } from '../data/session.js';

const NOW_HTML = `
  <style>
    .pt-chainpulse-body {
      padding: 4px 16px 10px 16px;
      display: flex;
      flex-direction: column;
    }
    .pt-cp-density-row {
      display: flex;
      gap: 14px;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      align-items: baseline;
      padding: 2px 0 4px 0;
    }
    .pt-cp-density-row > span { white-space: nowrap; }
    .pt-cp-density-label {
      font-size: 10px;
      letter-spacing: 0.06em;
      opacity: 0.55;
      text-transform: uppercase;
    }
    .pt-cp-controls {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 0 4px 0;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .pt-cp-stats-inline {
      display: flex;
      gap: 14px;
    }
    .pt-cp-timer-row {
      display: flex;
      align-items: center;
      gap: 12px;
      padding-top: 2px;
    }
    .pt-cp-timer {
      font-size: 22px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      line-height: 1;
      min-width: 64px;
      color: var(--pt-status-good);
      transition: color 0.3s linear;
    }
    .pt-cp-progress {
      flex: 1;
      height: 8px;
      background: var(--pt-border);
      border-radius: 4px;
      overflow: hidden;
      display: block;
    }
    .pt-cp-progress-fill {
      display: block;
      height: 100%;
      width: 0%;
      background: var(--pt-status-good);
      transition: width 0.3s linear, background 0.3s linear;
    }
    .pt-now { position: relative; }
    .pt-loading {
      position: absolute; inset: 0; z-index: 50;
      display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
      background: var(--pt-bg, #0b0f17);
      transition: opacity 0.4s ease;
    }
    .pt-loading.pt-hidden { opacity: 0; pointer-events: none; visibility: hidden; }
    .pt-loading-spinner {
      width: 44px; height: 44px; border: 3px solid var(--pt-border);
      border-top-color: var(--pt-accent-blue); border-radius: 50%;
      animation: pt-spin 0.9s linear infinite;
    }
    @keyframes pt-spin { to { transform: rotate(360deg); } }
    .pt-loading-text { font: 600 15px ui-monospace, monospace; color: #ffffff; letter-spacing: 0.04em; }
    .pt-loading-sub { font: 400 12px ui-monospace, monospace; color: var(--pt-text-secondary, #c9d1d9); max-width: 460px; text-align: center; line-height: 1.5; }
    .pt-loading-steps {
      display: flex; flex-direction: column; gap: 7px; margin-top: 6px;
      font: 400 12px ui-monospace, monospace; min-width: 260px;
    }
    .pt-loading-step { display: flex; align-items: center; gap: 10px; color: var(--pt-text-secondary, #c9d1d9); }
    .pt-loading-step .ico { width: 16px; text-align: center; flex: 0 0 16px; }
    .pt-loading-step.pending .ico { color: var(--pt-accent-blue); }
    .pt-loading-step.done { color: #ffffff; }
    .pt-loading-step.done .ico { color: var(--pt-status-good, #4ade80); }
    .pt-loading-step.waiting { color: var(--pt-text-muted); }
    .pt-loading-step .elapsed { color: var(--pt-text-muted); font-size: 11px; }
    .pt-mini-spin {
      display: inline-block; width: 11px; height: 11px; border: 2px solid var(--pt-border);
      border-top-color: var(--pt-accent-blue); border-radius: 50%;
      animation: pt-spin 0.8s linear infinite; vertical-align: -1px;
    }
    @keyframes pt-pulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
  </style>
  <div class="pt-now">
    <div class="pt-loading" id="pt-loading">
      <div class="pt-loading-spinner"></div>
      <div class="pt-loading-text">PoolTerminal is gathering live data from your node…</div>
      <div class="pt-loading-sub" id="pt-loading-sub">Connecting over SSH and querying the node — first connect can take up to 2 minutes.</div>
      <div class="pt-loading-steps" id="pt-loading-steps"></div>
    </div>
    <div class="pt-hero-row pt-hero-row-8">
      <div class="pt-hero-card" id="hero-epoch">
        <div class="pt-hero-label">Epoch</div>
        <div class="pt-hero-value" id="hero-epoch-val">—<span class="pt-hero-unit">%</span></div>
        <div class="pt-hero-bar"><div class="pt-hero-bar-fill" id="hero-epoch-bar"></div></div>
      </div>
      <div class="pt-hero-card" id="hero-pulse">
        <div class="pt-hero-label">Pulse</div>
        <div class="pt-hero-value" id="hero-pulse-val">—<span class="pt-hero-unit">/100</span></div>
        <div class="pt-hero-sub" id="hero-pulse-delta">—</div>
      </div>
      <div class="pt-hero-card" id="hero-kes">
        <div class="pt-hero-label">KES</div>
        <div class="pt-hero-value" id="hero-kes-val">—<span class="pt-hero-unit">d</span></div>
        <div class="pt-hero-bar"><div class="pt-hero-bar-fill" id="hero-kes-bar"></div></div>
        <div class="pt-hero-sub" id="hero-kes-sub">—</div>
      </div>
      <div class="pt-hero-card" id="hero-ideal">
        <div class="pt-hero-label">Ideal</div>
        <div class="pt-hero-value" id="hero-ideal-val">—</div>
      </div>
      <div class="pt-hero-card" id="hero-leader">
        <div class="pt-hero-label">Leader</div>
        <div class="pt-hero-value" id="hero-leader-val">—</div>
      </div>
      <div class="pt-hero-card" id="hero-adopt">
        <div class="pt-hero-label">Adopt</div>
        <div class="pt-hero-value" id="hero-adopt-val">—</div>
        <div class="pt-hero-sub" id="hero-adopt-sub">—</div>
      </div>
      <div class="pt-hero-card" id="hero-conf">
        <div class="pt-hero-label">Confirmed</div>
        <div class="pt-hero-value" id="hero-conf-val">—</div>
      </div>
      <div class="pt-hero-card" id="hero-lost">
        <div class="pt-hero-label">Lost</div>
        <div class="pt-hero-value" id="hero-lost-val">—</div>
      </div>
    </div>

    <div class="pt-panel">
      <div class="pt-panel-header">
        <span class="pt-panel-title">Chain pulse</span>
        <span class="pt-panel-meta">
          <span id="cp-attip"></span>
          <span class="pt-sep">│</span>
          <span class="pt-muted">block</span>&nbsp;<span id="cp-tipblock">—</span>
          <span class="pt-sep">│</span>
          <span class="pt-muted">slot</span>&nbsp;<span id="cp-slot">—</span>
          <span class="pt-sep">│</span>
          <span class="pt-muted">ep-slot</span>&nbsp;<span id="cp-epslot">—</span>
          <span class="pt-sep">│</span>
          <span id="cp-blockcount" class="pt-muted">—</span>
        </span>
      </div>
      <div class="pt-chainpulse-body">
        <div class="pt-cp-density-row">
          <span class="pt-cp-density-label">Density</span>
          <span><span class="pt-muted">1m</span>&nbsp;<span id="cp-d-m1">—</span></span>
          <span><span class="pt-muted">5m</span>&nbsp;<span id="cp-d-m5">—</span></span>
          <span><span class="pt-muted">20m</span>&nbsp;<span id="cp-d-m20">—</span></span>
          <span><span class="pt-muted">1h</span>&nbsp;<span id="cp-d-h1">—</span></span>
          <span><span class="pt-muted">1d</span>&nbsp;<span id="cp-d-d1">—</span></span>
          <span><span class="pt-muted">epoch</span>&nbsp;<span id="cp-d-epoch">—</span></span>
        </div>
        <svg class="pt-cp-heartbeat" id="cp-heartbeat"
             viewBox="0 0 600 120" preserveAspectRatio="none"
             style="height: 140px !important; width: 100%; display: block;"></svg>
        <div class="pt-cp-controls">
          <span class="pt-cp-tabs" id="cp-tabs">
            <span class="pt-cp-tab" data-window="10">10s</span>
            <span class="pt-cp-tab" data-window="30">30s</span>
            <span class="pt-cp-tab" data-window="60">1m</span>
            <span class="pt-cp-tab" data-window="300">5m</span>
            <span class="pt-cp-tab" data-window="900">15m</span>
            <span class="pt-cp-tab" data-window="3600">1h</span>
          </span>
          <span class="pt-cp-stats-inline">
            <span><span class="pt-muted">AVG</span>&nbsp;<span id="cp-avg">—</span></span>
            <span><span class="pt-muted">MAX</span>&nbsp;<span id="cp-max">—</span></span>
            <span><span class="pt-muted">MIN</span>&nbsp;<span id="cp-min">—</span></span>
          </span>
        </div>
        <div class="pt-cp-timer-row">
          <span class="pt-cp-timer" id="cp-since">—</span>
          <span class="pt-cp-progress">
            <span class="pt-cp-progress-fill" id="cp-progress-fill"></span>
          </span>
        </div>
      </div>
    </div>

    <div class="pt-now-grid">
      <div class="pt-panel pt-panel-flex pt-grid-mempool">
        <div class="pt-panel-header">
          <span class="pt-panel-title">Mempool</span>
          <span class="pt-panel-meta"><span id="mp-count">—</span></span>
        </div>
        <div class="pt-mp-body" id="mp-body"></div>
      </div>

      <div class="pt-panel pt-panel-flex pt-grid-peers">
        <div class="pt-panel-header">
          <span class="pt-panel-title">Peers</span>
          <span class="pt-panel-meta">
            <span class="pt-muted">OUT</span>&nbsp;<span id="pp-out">—</span>
            <span class="pt-sep">·</span>
            <span class="pt-muted">IN</span>&nbsp;<span id="pp-in">—</span>
            <span class="pt-sep">·</span>
            <span class="pt-muted">BiDir</span>&nbsp;<span id="pp-bidir">—</span>
            <span class="pt-sep">·</span>
            <span class="pt-muted">Duplex</span>&nbsp;<span id="pp-duplex">—</span>
          </span>
        </div>
        <div class="pt-pp-body" id="pp-body"></div>
      </div>

      <div class="pt-panel pt-panel-flex pt-grid-upcoming">
        <div class="pt-panel-header">
          <span class="pt-panel-title">Upcoming blocks</span>
          <span class="pt-panel-meta"><span id="ub-count" class="pt-muted">—</span></span>
        </div>
        <div class="pt-ub-body" id="ub-body"></div>
      </div>

      <div class="pt-panel pt-panel-flex pt-grid-map">
        <div class="pt-panel-header">
          <span class="pt-panel-title">Relay map</span>
          <span class="pt-panel-meta"><span id="rm-meta" class="pt-muted">—</span></span>
        </div>
        <div class="pt-rm-body">
          <svg class="pt-rm-svg" id="rm-svg" viewBox="0 0 720 360" preserveAspectRatio="xMidYMid meet"></svg>
        </div>
      </div>
    </div>

  </div>`;

// Loading overlay: a live checklist so the user sees what's loading and what's
// still pending, not just a spinner. Each step is "done" when its rendered value
// actually appears (reads the DOM, so it stays honest). The overlay clears when
// the last step (Ideal) lands, with a 2-min fallback so it can never stick.
const LOADING_FALLBACK_MS = 120_000;
let _loadingDone = false;
let _loadingTimer = null;
let _loadingTick = null;
let _loadingStart = 0;
let _steps = [];
// Once the first full load completes this session, returning to the NOW tab
// must NOT re-run the loader (it would wait again, and on a relay that's the
// full 2-min fallback). Reset only on a fresh connection (resetNowLoading).
let _initialLoadComplete = false;

function hasDigit(id) { const el = document.getElementById(id); return !!el && /\d/.test(el.textContent || ''); }

// Is the connected node a block producer? Relays have no pool keys, so KES and
// leader/ideal NEVER arrive — they must not be required loading steps, or the
// loader hangs to the 2-min fallback on every relay connect.
function isBPNode() {
  try {
    const p = getNodeProbe && getNodeProbe();
    return !!(p && typeof p.role === 'string' && p.role.toLowerCase() === 'bp');
  } catch { return false; }
}

// Build the checklist for the connected node. Universal steps (tip, peers,
// mempool, chain pulse) apply to BP and relay alike; KES + Ideal are BP-only.
// Dismissal gates on chain pulse — the genuinely-last thing — for both.
function buildSteps() {
  const head = [{ label: 'Connecting to node', ready: () => true }];
  const bpOnly = isBPNode() ? [
    { label: 'KES expiry',     ready: () => hasDigit('hero-kes-val') },
    { label: 'Ideal & leader', ready: () => hasDigit('hero-ideal-val') },
  ] : [];
  const universal = [
    { label: 'Chain tip & sync', ready: () => hasDigit('ttape-sync') || hasDigit('cp-tipblock') },
    { label: 'Peers',            ready: () => hasDigit('pp-out') || hasDigit('ttape-peers') },
    { label: 'Mempool',          ready: () => { const e = document.getElementById('mp-count'); return !!e && (e.textContent || '').trim() !== '' && (e.textContent || '').trim() !== '—'; } },
    { label: 'Chain pulse',      ready: () => hasDigit('cp-avg') || hasDigit('cp-d-m1') || hasDigit('cp-tipblock') },
  ];
  return [...head, ...bpOnly, ...universal];
}

/** Reset the load-once gate — call on a fresh connection so the loader shows. */
export function resetNowLoading() { _initialLoadComplete = false; }

// The overlay is done when every (role-appropriate) step is ready.
function allStepsReady() { return _steps.every((s) => { try { return s.ready(); } catch { return false; } }); }

function renderLoadingSteps() {
  const box = document.getElementById('pt-loading-steps');
  if (!box) return;
  const elapsed = _loadingStart ? Math.floor((Date.now() - _loadingStart) / 1000) : 0;
  let firstPending = true;
  box.innerHTML = _steps.map((s) => {
    const done = s.ready();
    if (done) return `<div class="pt-loading-step done"><span class="ico">✓</span><span>${s.label}</span></div>`;
    if (firstPending) {
      firstPending = false;
      return `<div class="pt-loading-step pending"><span class="ico"><span class="pt-mini-spin"></span></span><span>${s.label}</span><span class="elapsed">${elapsed}s</span></div>`;
    }
    return `<div class="pt-loading-step waiting"><span class="ico">·</span><span>${s.label}</span></div>`;
  }).join('');
}

function hideLoading() {
  _loadingDone = true;
  _initialLoadComplete = true;
  const el = document.getElementById('pt-loading');
  if (el) el.classList.add('pt-hidden');
  if (_loadingTimer) { clearTimeout(_loadingTimer); _loadingTimer = null; }
  if (_loadingTick) { clearInterval(_loadingTick); _loadingTick = null; }
}

function maybeHideLoading() {
  if (_loadingDone) return;
  renderLoadingSteps();
  if (allStepsReady()) {
    // Everything's in (chain pulse was the slow tail) — render the final
    // all-green checklist, then hold ~1s so the completed state is visible
    // before fading out. Confirms to the user it actually finished.
    _loadingDone = true;
    _initialLoadComplete = true;
    if (_loadingTick) { clearInterval(_loadingTick); _loadingTick = null; }
    if (_loadingTimer) { clearTimeout(_loadingTimer); _loadingTimer = null; }
    renderLoadingSteps();
    setTimeout(fadeOutLoading, 1000);
  }
}

function fadeOutLoading() {
  const el = document.getElementById('pt-loading');
  if (el) el.classList.add('pt-hidden');
}

export function mountNow(canvas) {
  canvas.innerHTML = NOW_HTML;
  resetHero();
  initChainPulse();
  // Show a "calculating" placeholder rather than the empty state — the leader
  // schedule query is slow first-time-per-epoch (cached after), so make it clear
  // the panel is working, not that there are no blocks.
  const ubBody = canvas.querySelector('#ub-body');
  const ubCount = canvas.querySelector('#ub-count');
  if (ubBody) ubBody.innerHTML = '<div class="pt-ub-empty">Calculating leader schedule…</div>';
  if (ubCount) ubCount.textContent = 'calculating…';
  renderRelayMap();
  initRelayMap();
  resetPeersPanel();

  _steps = buildSteps();   // role-aware: relays drop KES/Ideal

  // Returning to NOW after the first full load — don't re-run the loader (it
  // would wait again, up to the 2-min fallback). The live loop refills panels
  // on its next tick. Only a fresh connection (resetNowLoading) shows it again.
  if (_initialLoadComplete) {
    _loadingDone = true;
    const el = document.getElementById('pt-loading');
    if (el) el.classList.add('pt-hidden');
    return;
  }

  _loadingDone = false;
  _loadingStart = Date.now();
  renderLoadingSteps();
  if (_loadingTimer) clearTimeout(_loadingTimer);
  if (_loadingTick) clearInterval(_loadingTick);
  _loadingTick = setInterval(maybeHideLoading, 1000);   // live independent of the SSH-blocked loop
  _loadingTimer = setTimeout(hideLoading, LOADING_FALLBACK_MS);
}

export function updateNowFast(snap) {
  renderHero(snap);
  setChainPulseStatus(snap.atTip, snap.tipBlock, snap.slot, snap.slotInEpoch, snap.epochLength);
  maybeHideLoading();
}

export async function bootstrapNow(src) {
  const [pulse, mp] = await Promise.all([
    src.getChainPulse(),
    src.getMempool(),
  ]);
  renderChainPulse(pulse);
  renderMempool(mp);
}

export async function refreshMempool(src, tipBlock) {
  const mp = await src.getMempool();
  renderMempool(mp, { tipBlock });
}

export async function refreshUpcomingBlocks(src) {
  const list = await src.getUpcomingBlocks();
  renderUpcomingBlocks(list);
}

export function unmountNow() {
  stopChainPulse();
  stopUpcomingBlocks();
  if (_loadingTimer) { clearTimeout(_loadingTimer); _loadingTimer = null; }
  if (_loadingTick) { clearInterval(_loadingTick); _loadingTick = null; }
}
