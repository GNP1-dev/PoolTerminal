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
import * as readModel from '../data/read-model.js';

const NOW_HTML = `
  <style>
    /* Cosmetic: make the block-production counts (Leader / Adopt / Confirmed /
       Lost) read much larger than the other hero cards. */
    #hero-leader-val, #hero-adopt-val, #hero-conf-val, #hero-lost-val {
      font-size: 40px;
      font-weight: 800;
      line-height: 1.04;
    }
    /* Label to the left of the chain-pulse window tabs ("Poll Period"). */
    .pt-cp-tabs-wrap { display: flex; align-items: center; }
    .pt-cp-controls-label {
      font-size: 10px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      opacity: 0.55;
      margin-right: 10px;
      white-space: nowrap;
    }
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
    <div class="pt-hero-row pt-hero-row-9">
      <div class="pt-hero-card" id="hero-blocks">
        <div class="pt-hero-label">Blocks minted</div>
        <div class="pt-hero-value" id="hero-blocks-val">—</div>
        <div class="pt-hero-sub" id="hero-blocks-sub">lifetime</div>
      </div>
      <div class="pt-hero-card" id="hero-epoch" title="Progress through the current epoch, with estimated time until the next epoch boundary.">
        <div class="pt-hero-label">Epoch</div>
        <div class="pt-hero-value" id="hero-epoch-val">—<span class="pt-hero-unit">%</span></div>
        <div class="pt-hero-bar"><div class="pt-hero-bar-fill" id="hero-epoch-bar"></div></div>
        <div class="pt-hero-sub" id="hero-epoch-eta">—</div>
      </div>
      <div class="pt-hero-card" id="hero-pulse" title="Pulse - PoolTerminal's overall health score (0-100), combining node sync, tip freshness, peer connectivity and KES validity. Higher is healthier; the arrow shows the change since the last reading.">
        <div class="pt-hero-label">Pulse</div>
        <div class="pt-hero-value" id="hero-pulse-val">—<span class="pt-hero-unit">/100</span></div>
        <div class="pt-hero-sub" id="hero-pulse-delta">—</div>
      </div>
      <div class="pt-hero-card" id="hero-kes" title="KES (Key Evolving Signature) validity - time until this node's operational certificate hot key expires. Once it expires the node stops minting until you rotate the KES key and issue a new op.cert.">
        <div class="pt-hero-label">KES</div>
        <div class="pt-hero-value" id="hero-kes-val">—<span class="pt-hero-unit">d</span></div>
        <div class="pt-hero-bar"><div class="pt-hero-bar-fill" id="hero-kes-bar"></div></div>
        <div class="pt-hero-sub" id="hero-kes-sub">—</div>
      </div>
      <div class="pt-hero-card" id="hero-ideal" title="Ideal blocks (d) - the number of blocks this pool is mathematically expected to mint this epoch, based on its active stake and the protocol parameters.">
        <div class="pt-hero-label">Ideal</div>
        <div class="pt-hero-value" id="hero-ideal-val">—</div>
      </div>
      <div class="pt-hero-card" id="hero-leader" title="Leader Slots - slots this epoch where this pool is the elected slot leader and is scheduled to mint a block (from the leadership schedule).">
        <div class="pt-hero-label">Leader</div>
        <div class="pt-hero-value" id="hero-leader-val">—</div>
      </div>
      <div class="pt-hero-card" id="hero-adopt" title="Blocks Adopted - blocks this pool has minted that have been adopted into the local node's chain this epoch. Luck compares blocks made so far against the ideal expectation.">
        <div class="pt-hero-label">Adopted</div>
        <div class="pt-hero-value" id="hero-adopt-val">—</div>
        <div class="pt-hero-sub" id="hero-adopt-sub">—</div>
      </div>
      <div class="pt-hero-card" id="hero-conf" title="Blocks Confirmed - adopted blocks that have since received enough confirmations to be considered settled on-chain.">
        <div class="pt-hero-label">Confirmed</div>
        <div class="pt-hero-value" id="hero-conf-val">—</div>
      </div>
      <div class="pt-hero-card" id="hero-lost" title="Blocks Lost - blocks this pool was leader for but did not make it onto the chain: missed slots, or blocks that lost a slot/height battle (ghosted or orphaned).">
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
          <span class="pt-cp-tabs-wrap">
            <span class="pt-cp-controls-label">Poll Period</span>
            <span class="pt-cp-tabs" id="cp-tabs">
              <span class="pt-cp-tab" data-window="10">10s</span>
              <span class="pt-cp-tab" data-window="30">30s</span>
              <span class="pt-cp-tab" data-window="60">1m</span>
              <span class="pt-cp-tab" data-window="300">5m</span>
              <span class="pt-cp-tab" data-window="900">15m</span>
              <span class="pt-cp-tab" data-window="3600">1h</span>
            </span>
          </span>
          <span class="pt-cp-stats-inline">
            <span id="cp-blockcount" class="pt-muted">—</span>
            <span><span class="pt-muted">AVG</span>&nbsp;<span id="cp-avg">—</span></span>
            <span><span class="pt-muted">MAX</span>&nbsp;<span id="cp-max">—</span></span>
            <span><span class="pt-muted">MIN</span>&nbsp;<span id="cp-min">—</span></span>
          </span>
        </div>
        <div class="pt-cp-timer-row">
          <span class="pt-cp-controls-label">Tip (diff)</span>
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
          <span class="pt-panel-meta" style="margin-left:10px;gap:5px;">
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
let _firstSnapshotRendered = false;
let _loadingTimer = null;
let _loadingTick = null;
let _loadingStart = 0;
// Epoch countdown: store the absolute end time (ms) derived from each snapshot,
// then a local 1s timer counts down to it — no API calls, ticks every second.
let _epochEndMs = null;
let _lastEpochSlot = null;  // last slotInEpoch we synced from /*epcd-slotguard*/
let _epochTimer = null;
let _steps = [];
// Once the first full load completes this session, returning to the NOW tab
// must NOT re-run the loader (it would wait again, and on a relay that's the
// full 2-min fallback). Reset only on a fresh connection (resetNowLoading).
let _initialLoadComplete = false;
// Last-known values, retained so returning to NOW can paint instantly (cache-
// first) instead of blanking and waiting for the next live tick. Refreshed in
// the background by the live loop. Cleared on a fresh connection.
let _lastSnap = null;
let _lastUpcoming = null;

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

// Positively confirmed relay: probe resolved AND role is a known non-BP role.
// Unknown/unresolved role → false (so we DON'T label until we're sure).
export function isRelayConfirmed() { /*relay-export*/
  try {
    const p = getNodeProbe && getNodeProbe();
    if (!p || typeof p.role !== 'string') return false;
    const r = p.role.trim().toLowerCase();
    return r !== '' && r !== 'bp' && r !== 'unknown';
  } catch { return false; }
}

// Idempotent: set the BP-only hero card labels to "(relay)" iff a relay is
// confirmed, else restore the plain label. Safe to call every tick — it only
// writes when the text needs changing, and self-corrects once the probe lands.
const BP_CARD_LABELS = {
  'hero-kes': 'KES', 'hero-ideal': 'Ideal', 'hero-leader': 'Leader',
  'hero-adopt': 'Adopted', 'hero-conf': 'Confirmed', 'hero-lost': 'Lost',
};
function applyRelayLabels(canvas) {
  const root = canvas || document;
  const relay = isRelayConfirmed();
  for (const [cardId, base] of Object.entries(BP_CARD_LABELS)) {
    const card = root.querySelector ? root.querySelector('#' + cardId) : document.getElementById(cardId);
    const lbl = card && card.querySelector('.pt-hero-label');
    if (!lbl) continue;
    const want = relay ? `${base} (relay)` : base;
    if (lbl.textContent !== want) lbl.textContent = want;
  }
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
export function resetNowLoading() { _initialLoadComplete = false; _lastSnap = null; _lastUpcoming = null; }

// The overlay is done when every (role-appropriate) step is ready AND the first
// real fast-loop snapshot has rendered. Steps are REBUILT each check: the node
// role isn't resolved at mount time, so a BP would otherwise get a relay-style
// checklist (no KES/Ideal gating) and the loader would dismiss before those
// BP-only cards load. Rebuilding here picks up the role once the probe lands.
function allStepsReady() {
  if (!_firstSnapshotRendered) return false;
  _steps = buildSteps();
  return _steps.every((s) => { try { return s.ready(); } catch { return false; } });
}

function renderLoadingSteps() {
  const box = document.getElementById('pt-loading-steps');
  if (!box) return;
  _steps = buildSteps();   // reflect the role once the probe resolves
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

// Lifetime blocks = sum of adopted blocks across all tracked epochs (incl. the
// current one). Read from the read-model history cache — portable (db-sync or
// Koios), no extra API call. Updates the hero card when ready.
export async function refreshLifetimeBlocks() {
  try {
    // Authoritative lifetime total from Koios pool_info.block_count (the exact
    // field gLiveView displays) - it counts the current and just-ended epochs,
    // which pool_history excludes. Summing cached epoch rows undercounts those.
    const info = readModel.liveInfo();
    const el = document.getElementById('hero-blocks-val');
    const sub = document.getElementById('hero-blocks-sub');
    if (info && info.blockCountLifetime != null) {
      el && (el.textContent = Number(info.blockCountLifetime).toLocaleString());
      if (sub) {
        const rows = await readModel.getEpochHistory(0, 9_999_999);
        const producing = Array.isArray(rows) ? rows.filter((r) => (r.adopted || 0) > 0).length : 0;
        sub.textContent = producing ? `${producing} epochs` : 'lifetime';
      }
      return;
    }
    // Fallback (no pool_info yet, e.g. db-sync only): sum cached epochs.
    const rows = await readModel.getEpochHistory(0, 9_999_999);
    if (!Array.isArray(rows) || !rows.length) return;
    const total = rows.reduce((s, r) => s + (r && r.adopted ? Number(r.adopted) : 0), 0);
    if (el) el.textContent = total.toLocaleString();
    if (sub) sub.textContent = `${rows.filter((r) => (r.adopted || 0) > 0).length} epochs`;
  } catch { /* leave placeholder */ }
}

export function mountNow(canvas) {
  canvas.innerHTML = NOW_HTML;
  resetHero();
  initChainPulse();
  const ubBody = canvas.querySelector('#ub-body');
  const ubCount = canvas.querySelector('#ub-count');
  if (_initialLoadComplete && (_lastSnap || _lastUpcoming)) {
    // Returning to NOW: paint last-known values immediately (cache-first); the
    // live loop refreshes them on its next tick. No blank "calculating" state.
    if (_lastSnap) {
      renderHero(_lastSnap);
      if (_lastSnap.epochLength != null && _lastSnap.slotInEpoch != null) {
        const secsLeft = Math.max(0, _lastSnap.epochLength - _lastSnap.slotInEpoch);
        _epochEndMs = Date.now() + secsLeft * 1000;
      }
    }
    if (_lastUpcoming) renderUpcomingBlocks(_lastUpcoming, { isRelay: isRelayConfirmed() });
    else if (ubBody) { ubBody.innerHTML = '<div class="pt-ub-empty">Calculating leader schedule…</div>'; if (ubCount) ubCount.textContent = 'calculating…'; }
  } else {
    // First load this connection - the leader schedule query is slow first-time-
    // per-epoch (cached after), so show that the panel is working.
    if (ubBody) ubBody.innerHTML = '<div class="pt-ub-empty">Calculating leader schedule…</div>';
    if (ubCount) ubCount.textContent = 'calculating…';
  }
  renderRelayMap();
  initRelayMap();
  // Lifetime blocks (sum of adopted across all epochs incl. current) — portable,
  // from the read-model history cache (no extra API). Fills async.
  refreshLifetimeBlocks();
  resetPeersPanel();

  _steps = buildSteps();   // role-aware: relays drop KES/Ideal

  // On a relay, the block-production hero cards (KES/Ideal/Leader/Adopt/
  // Confirmed/Lost) can never fill — they need pool keys. Mark their labels
  // "(relay)" so it's obvious why they're blank. This is applied idempotently
  // by applyRelayLabels() (called here AND every fast tick) so it reflects the
  // CONFIRMED probe role — at mount the role may not be resolved yet, and
  // labeling once at mount wrongly stamped "(relay)" on a BP whose probe hadn't
  // landed. The per-tick pass self-corrects once the role is known.
  applyRelayLabels(canvas);

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
  _firstSnapshotRendered = false;
  renderLoadingSteps();
  if (_loadingTimer) clearTimeout(_loadingTimer);
  if (_loadingTick) clearInterval(_loadingTick);
  _loadingTick = setInterval(maybeHideLoading, 1000);   // live independent of the SSH-blocked loop
  _loadingTimer = setTimeout(hideLoading, LOADING_FALLBACK_MS);
  // Local epoch countdown — ticks every second with no API calls.
  if (_epochTimer) clearInterval(_epochTimer);
  _epochTimer = setInterval(tickEpochCountdown, 1000);
}

// Render the epoch-end countdown from the stored absolute end time. Called by a
// local 1s timer (smooth tick) and re-synced on each snapshot. No API calls.
function tickEpochCountdown() {
  const el = document.getElementById('hero-epoch-eta');
  if (!el) return;
  if (_epochEndMs == null) { el.textContent = '—'; return; }
  let secsLeft = Math.max(0, Math.round((_epochEndMs - Date.now()) / 1000));
  const d = Math.floor(secsLeft / 86400);
  const h = Math.floor((secsLeft % 86400) / 3600);
  const m = Math.floor((secsLeft % 3600) / 60);
  const s = secsLeft % 60;
  el.textContent = `${d}d ${h}h ${m}m ${s}s to end`;
}

export function updateNowFast(snap) {
  _lastSnap = snap;
  renderHero(snap);
  // Re-sync the epoch-end time from the snapshot (1 slot = 1 second). The local
  // timer counts down to this between snapshots, so it stays accurate.
  if (snap && snap.epochLength != null && snap.slotInEpoch != null) {
    // Only re-anchor on a genuinely fresh tip. Re-anchoring every fast tick
    // from a stale slot would pin the countdown until the next live tip.
    if (snap.slotInEpoch !== _lastEpochSlot || _epochEndMs == null) {
      _lastEpochSlot = snap.slotInEpoch;
      const secsLeft = Math.max(0, snap.epochLength - snap.slotInEpoch);
      _epochEndMs = Date.now() + secsLeft * 1000;
    }
    tickEpochCountdown();
  }
  applyRelayLabels(document);   // idempotent; self-corrects once probe role is known
  // Sync %: shown under the Tip diff gauge on the Dashboard (now2). /*n2-sync*/
  if (snap && snap.syncPercent != null) {
    const sEl = document.getElementById('n2-sync');
    if (sEl) {
      sEl.textContent = snap.syncPercent.toFixed(1) + '%';
      sEl.style.color = (snap.atTip && snap.syncPercent >= 99.95)
        ? 'var(--pt-status-good)' : 'var(--pt-status-warn)';
    }
  }
  setChainPulseStatus(snap.atTip, snap.tipBlock, snap.slot, snap.slotInEpoch, snap.epochLength);
  if (snap && (snap.tipBlock != null || snap.slot != null)) _firstSnapshotRendered = true;
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
  _lastUpcoming = list;
  renderUpcomingBlocks(list, { isRelay: isRelayConfirmed() });
}

// Epoch-end absolute time (ms). Maintained on every snapshot by updateNowFast.
// Exposed so the Dashboard (now2) can render a smooth per-second countdown
// from its own 1s timer without any API calls. /*epcd-getter*/
export function getEpochEndMs() { return _epochEndMs; }

export function unmountNow() {
  stopChainPulse();
  stopUpcomingBlocks();
  if (_loadingTimer) { clearTimeout(_loadingTimer); _loadingTimer = null; }
  if (_loadingTick) { clearInterval(_loadingTick); _loadingTick = null; }
  if (_epochTimer) { clearInterval(_epochTimer); _epochTimer = null; }
  _epochEndMs = null;
  _lastEpochSlot = null;
}
