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
  </style>
  <div class="pt-now">
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

export function mountNow(canvas) {
  canvas.innerHTML = NOW_HTML;
  resetHero();
  initChainPulse();
  renderUpcomingBlocks([]);
  renderRelayMap();
  initRelayMap();
  resetPeersPanel();
}

export function updateNowFast(snap) {
  renderHero(snap);
  setChainPulseStatus(snap.atTip, snap.tipBlock);
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
}
