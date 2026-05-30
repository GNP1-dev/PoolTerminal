/**
 * PoolTerminal — NOW view.
 * Layout: hero / chain pulse / (BP | Mempool) / (Upcoming | Relay map elastic row).
 *
 * Exports split for two-tier polling:
 *   updateNowFast(snap)     — every fast tick (~1s). Hero + BP + chain pulse
 *                              header status. No SSH I/O.
 *   bootstrapNow(src)        — one-time at startup, in background. Pulls
 *                              cncli history + initial mempool via SSH.
 *   refreshMempool(src)      — every ~5s. Mempool gauge refresh via SSH.
 */

import { renderHero, resetHero } from '../ui/now-hero.js';
import {
  renderChainPulse,
  initChainPulse,
  setChainPulseStatus,
  stopChainPulse,
} from '../ui/chain-pulse.js';
import { renderBlockProduction, resetBlockProduction } from '../ui/block-production.js';
import { renderUpcomingBlocks, stopUpcomingBlocks } from '../ui/upcoming-blocks.js';
import { renderMempool } from '../ui/mempool.js';
import { renderRelayMap } from '../ui/relay-map.js';

const NOW_HTML = `
  <div class="pt-now">
    <div class="pt-hero-row">
      <div class="pt-hero-card" id="hero-pulse">
        <div class="pt-hero-label">Pulse</div>
        <div class="pt-hero-value" id="hero-pulse-val">—<span class="pt-hero-unit">/100</span></div>
        <div class="pt-hero-sub" id="hero-pulse-delta">—</div>
      </div>
      <div class="pt-hero-card" id="hero-epoch">
        <div class="pt-hero-label">Epoch</div>
        <div class="pt-hero-value" id="hero-epoch-val">—<span class="pt-hero-unit">%</span></div>
        <div class="pt-hero-bar"><div class="pt-hero-bar-fill" id="hero-epoch-bar"></div></div>
      </div>
      <div class="pt-hero-card pt-hero-accent" id="hero-blocks">
        <div class="pt-hero-label">Blocks</div>
        <div class="pt-hero-value" id="hero-blocks-val">—<span class="pt-hero-unit">/—</span></div>
        <div class="pt-hero-sub" id="hero-blocks-sub">—</div>
      </div>
      <div class="pt-hero-card" id="hero-kes">
        <div class="pt-hero-label">KES</div>
        <div class="pt-hero-value" id="hero-kes-val">—<span class="pt-hero-unit">d</span></div>
        <div class="pt-hero-sub" id="hero-kes-sub">—</div>
      </div>
    </div>

    <div class="pt-panel">
      <div class="pt-panel-header">
        <span class="pt-panel-title">Chain pulse</span>
        <span class="pt-panel-meta">
          <span id="cp-attip"></span>
          <span class="pt-sep">│</span>
          <span class="pt-muted">block</span>&nbsp;<span id="cp-tipblock">—</span>
        </span>
      </div>
      <div class="pt-chainpulse-body">
        <div class="pt-cp-top">
          <div>
            <div class="pt-cp-since-label">Since last block</div>
            <div class="pt-cp-since" id="cp-since">—</div>
          </div>
          <div class="pt-cp-stats">
            <div><span class="pt-muted">AVG</span>&nbsp;&nbsp;<span id="cp-avg">—</span></div>
            <div><span class="pt-muted">MAX</span>&nbsp;&nbsp;<span id="cp-max">—</span></div>
            <div><span class="pt-muted">MIN</span>&nbsp;&nbsp;<span id="cp-min">—</span></div>
          </div>
        </div>
        <div class="pt-cp-hb-label">
          <span>HEARTBEAT</span>
          <span class="pt-cp-hb-right">
            <span class="pt-cp-tabs" id="cp-tabs">
              <span class="pt-cp-tab" data-window="60">1m</span>
              <span class="pt-cp-tab" data-window="300">5m</span>
              <span class="pt-cp-tab" data-window="900">15m</span>
              <span class="pt-cp-tab" data-window="3600">1h</span>
            </span>
            <span class="pt-accent" id="cp-blockcount">—</span>
          </span>
        </div>
        <svg class="pt-cp-heartbeat" id="cp-heartbeat" viewBox="0 0 600 56" preserveAspectRatio="none"></svg>
        <div class="pt-cp-density-label">DENSITY · blocks ÷ slots</div>
        <div class="pt-cp-density">
          <div class="pt-cp-dcell"><div class="pt-cp-dwin">1m</div><div class="pt-cp-dval" id="cp-d-m1">—</div></div>
          <div class="pt-cp-dcell"><div class="pt-cp-dwin">5m</div><div class="pt-cp-dval" id="cp-d-m5">—</div></div>
          <div class="pt-cp-dcell"><div class="pt-cp-dwin">20m</div><div class="pt-cp-dval" id="cp-d-m20">—</div></div>
          <div class="pt-cp-dcell"><div class="pt-cp-dwin">1h</div><div class="pt-cp-dval" id="cp-d-h1">—</div></div>
          <div class="pt-cp-dcell"><div class="pt-cp-dwin">1d</div><div class="pt-cp-dval" id="cp-d-d1">—</div></div>
          <div class="pt-cp-dcell"><div class="pt-cp-dwin">epoch</div><div class="pt-cp-dval" id="cp-d-epoch">—</div></div>
        </div>
      </div>
    </div>

    <div class="pt-now-2col">
      <div class="pt-panel">
        <div class="pt-panel-header">
          <span class="pt-panel-title">Block production</span>
          <span class="pt-panel-meta"><span class="pt-muted">this epoch</span></span>
        </div>
        <div class="pt-bp-grid">
          <div class="pt-bp-cell"><div class="pt-bp-label">Leader</div><div class="pt-bp-val" id="bp-leader">—</div></div>
          <div class="pt-bp-cell"><div class="pt-bp-label">Ideal</div><div class="pt-bp-val" id="bp-ideal">—</div></div>
          <div class="pt-bp-cell"><div class="pt-bp-label">Luck</div><div class="pt-bp-val" id="bp-luck">—</div></div>
          <div class="pt-bp-cell" id="bp-cell-adopt"><div class="pt-bp-label">Adopt</div><div class="pt-bp-val" id="bp-adopt">—</div></div>
          <div class="pt-bp-cell" id="bp-cell-conf"><div class="pt-bp-label">Conf</div><div class="pt-bp-val" id="bp-conf">—</div></div>
          <div class="pt-bp-cell"><div class="pt-bp-label">Lost</div><div class="pt-bp-val" id="bp-lost">—</div></div>
        </div>
      </div>

      <div class="pt-panel">
        <div class="pt-panel-header">
          <span class="pt-panel-title">Mempool</span>
          <span class="pt-panel-meta"><span id="mp-count">—</span></span>
        </div>
        <div class="pt-mp-body" id="mp-body"></div>
      </div>
    </div>

    <div class="pt-now-bottom">
      <div class="pt-panel pt-panel-flex">
        <div class="pt-panel-header">
          <span class="pt-panel-title">Upcoming blocks</span>
          <span class="pt-panel-meta"><span id="ub-count" class="pt-muted">—</span></span>
        </div>
        <div class="pt-ub-body" id="ub-body"></div>
      </div>

      <div class="pt-panel pt-panel-flex">
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

export function mountNow(canvas) {
  canvas.innerHTML = NOW_HTML;
  resetHero();
  resetBlockProduction();
  initChainPulse();
  renderUpcomingBlocks([]);
  renderRelayMap();
}

// Called every fast tick (~1s) — no SSH I/O, all derived from snap.
export function updateNowFast(snap) {
  renderHero(snap);
  renderBlockProduction(snap.blockProduction);
  setChainPulseStatus(snap.atTip, snap.tipBlock);
}

// One-time bootstrap on connect — pulls cncli history + initial mempool.
// Takes ~30s due to the cncli query but runs in background; fast loop
// continues polling tip the whole time.
export async function bootstrapNow(src) {
  const [pulse, mp] = await Promise.all([
    src.getChainPulse(),
    src.getMempool(),
  ]);
  renderChainPulse(pulse);
  renderMempool(mp);
}

// Called periodically (~5s) — just the mempool, fast (~110ms).
export async function refreshMempool(src) {
  const mp = await src.getMempool();
  renderMempool(mp);
}

export function unmountNow() {
  stopChainPulse();
  stopUpcomingBlocks();
}
