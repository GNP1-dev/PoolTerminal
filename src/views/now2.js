/**
 * PoolTerminal - NOW v2 (car-dashboard redesign), built as a PARALLEL tab.
 *
 * The original Now tab (now.js) is left completely untouched. now2 reuses the
 * SAME element IDs the existing painters write to (cp-heartbeat, hero-*-val,
 * mp-*, pp-*, ub-*, cp-d-*, cp-since), so live data flows in for free from
 * main.js's loop (updateNowFast, refreshMempool, refreshUpcomingBlocks). On top
 * we overlay the instrument gauges (now-gauges.js), which mirror the painted DOM
 * values on a 1s interval.
 *
 * Layout: hero = slim strip (at-tip/block/slot/ep-slot + poll period) above a
 * main row of [block production | heartbeat ECG | Health]. Then the instrument
 * deck (KES thermo | Density | Mempool | Tip-diff | Epoch thermo). Then Upcoming
 * blocks + Peers. Relay map dropped (still on the Map tab).
 */

import { initChainPulse, stopChainPulse, getActiveWindow, densityPctForWindow } from '../ui/chain-pulse.js';
import { speedoSVG, setSpeedo, thermoHTML, setThermo, tanksHTML, paintTanks, flashMint } from '../ui/now-gauges.js';
import { refreshLifetimeBlocks, getEpochEndMs, isRelayConfirmed } from './now.js';
import { getLastMetrics } from '../data/metrics-query.js';
import { getMode } from '../data/index.js';
import { getNodeProbe } from '../data/session.js';

let _mirrorTimer = null;
let _tick = 0;
let _n2Ready = false;
let _lastTip = null;
const MP_FULL = 90112;   // bytes = one block body (mainnet maxBlockBodySize)

const N2_HTML = `
  <style>
    .n2-wrap { flex:1 1 auto; min-height:0; overflow-y:auto; display:flex; flex-direction:column; gap:10px; padding:2px 2px 6px; }
    .n2-panel { background:linear-gradient(180deg,#0a0f1c,#070b15); border:2px solid rgba(150,182,235,.6); border-radius:13px; box-shadow:0 1px 5px rgba(0,0,0,.45); }
    .n2-lbl { font-size:var(--pt-text-label,12px); letter-spacing:var(--pt-tracking-label,0.7px); color:var(--pt-accent-blue-bright,#7BB0F5); text-transform:uppercase; font-weight:600; }

    /* hero: slim strip + main row */
    .n2-hero { padding:8px 14px 12px; display:flex; flex-direction:column; gap:8px; }
    .n2-hero-strip { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; padding-bottom:7px; border-bottom:1px solid rgba(135,165,215,.24); }
    .n2-tipline { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--pt-text-secondary,#9fb0d0); flex-wrap:wrap; }
    .n2-attip { font-weight:700; letter-spacing:1px; color:#5dff9b; text-shadow:0 0 8px rgba(93,255,155,.5); }
    .n2-tip-sep { color:rgba(120,150,200,.3); }
    .n2-poll { display:flex; align-items:center; gap:6px; }

    .n2-hero-main { display:flex; align-items:stretch; gap:16px; }
    .n2-blockbox { flex:0 0 auto; width:236px; display:flex; flex-direction:column; gap:9px; padding-right:16px; border-right:1px solid rgba(135,165,215,.24); }
    .n2-bb-life { display:flex; align-items:center; gap:11px; }
    .n2-bb-num { font-family:ui-monospace,monospace; font-weight:800; font-size:30px; color:#36e0d4; text-shadow:0 0 16px rgba(54,224,212,.5); line-height:1; }
    .n2-bb-cap { font-size:11px; color:var(--pt-text-muted,#6f7d99); text-transform:uppercase; letter-spacing:1px; line-height:1.35; }
    .n2-bb-sub { color:var(--pt-text-secondary,#9fb0d0); text-transform:none; letter-spacing:0; }
    .n2-bb-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:6px; }
    .n2-bb-stat { display:flex; flex-direction:column; align-items:center; background:rgba(120,150,200,.05); border:1px solid rgba(120,150,200,.10); border-radius:8px; padding:5px 3px; }
    .n2-bb-stat .k { font-size:8.5px; letter-spacing:.5px; color:var(--pt-text-muted,#6f7d99); text-transform:uppercase; }
    .n2-bb-stat .v { font-family:ui-monospace,monospace; font-weight:700; font-size:15px; margin-top:1px; color:var(--pt-text-primary,#e6edf3); }
    .n2-bb-stat .s { font-size:8px; color:var(--pt-text-muted,#6f7d99); margin-top:1px; min-height:9px; }
    .n2-hero-trace { flex:1 1 auto; min-width:0; display:flex; align-items:center; }
    .n2-hero-health { flex:0 0 auto; border-left:1px solid rgba(135,165,215,.24); padding-left:16px; display:flex; flex-direction:column; align-items:center; justify-content:center; min-width:92px; }
    .n2-hero-health .v { font-size:30px; font-weight:800; color:#36e0d4; text-shadow:0 0 16px rgba(54,224,212,.55); line-height:1; }
    .n2-hero-health .u { font-size:10px; color:var(--pt-text-muted,#6f7d99); letter-spacing:1px; margin-top:2px; }
    .n2-hero-health .d { font-size:11px; color:var(--pt-text-muted,#6f7d99); margin-top:4px; }

    /* instrument deck */
    .n2-deck { display:grid; grid-template-columns:0.8fr 1fr 1.5fr 1fr 0.8fr; gap:12px; }
    .n2-cell { padding:10px 10px 8px; display:flex; flex-direction:column; align-items:center; }
    .n2-cell .n2-lbl { margin-bottom:8px; }
    .n2-val { font-family:ui-monospace,monospace; font-weight:700; font-size:17px; margin-top:6px; }
    .n2-sub { font-size:11px; color:var(--pt-text-muted,#6f7d99); margin-top:2px; }
    .pt-speedo-tick { font-family:ui-monospace,monospace; font-size:9px; fill:#6f7d99; }
    .n2-density-grid { display:grid; grid-template-columns:repeat(3,auto); gap:3px 12px; justify-content:center; margin-top:8px; font-size:11px; font-family:ui-monospace,monospace; }
    .n2-gaps { width:100%; margin-top:12px; }
    .n2-gaps-head { font-size:10px; color:var(--pt-text-muted,#6f7d99); text-align:center; margin-bottom:6px; }
    .n2-gap-row { display:flex; align-items:center; gap:6px; margin:4px 0; font-size:11px; }
    .n2-gap-lbl { width:26px; color:var(--pt-text-muted,#6f7d99); text-transform:uppercase; letter-spacing:1px; }
    .n2-gap-track { flex:1; height:6px; background:rgba(120,150,200,.12); border-radius:3px; overflow:hidden; }
    .n2-gap-fill { display:block; height:100%; width:0; border-radius:3px; transition:width .6s ease; }
    .n2-gap-val { width:40px; text-align:right; font-family:ui-monospace,monospace; font-weight:700; }
    .pt-needle { transition:transform 1.2s cubic-bezier(.2,.8,.2,1); }

    /* thermometers + tanks */
    .pt-thermo { position:relative; width:62px; height:126px; margin-top:2px; }
    .pt-thermo-tube { position:absolute; left:16px; top:0; width:16px; height:108px; border-radius:9px; background:rgba(120,150,200,.10); border:1.5px solid rgba(160,185,225,.5); overflow:hidden; box-shadow:inset 0 0 6px rgba(0,0,0,.3); }
    .pt-thermo-ticks { position:absolute; left:0; top:0; width:100%; height:108px; pointer-events:none; }
    .pt-thermo-tick { position:absolute; left:34px; transform:translateY(50%); display:flex; align-items:center; gap:3px; }
    .pt-thermo-tick-line { width:7px; height:1.5px; background:rgba(160,185,225,.5); }
    .pt-thermo-tick-lbl { font-size:8.5px; color:var(--pt-text-muted,#6f7d99); font-family:ui-monospace,monospace; }
    .pt-thermo-fill { position:absolute; left:0; bottom:0; width:100%; border-radius:8px; transition:height 1.3s cubic-bezier(.2,.8,.2,1); }
    .pt-thermo-bulb { position:absolute; left:11px; bottom:0; width:28px; height:28px; border-radius:50%; }
    .pt-tanks { display:flex; gap:7px; align-items:flex-end; justify-content:center; height:104px; width:100%; }
    .pt-tank { position:relative; width:46px; height:98px; border:2px solid rgba(120,150,200,.22); border-radius:7px; overflow:hidden; background:rgba(10,16,28,.5); transition:border-color .4s; }
    .pt-tank-liq { position:absolute; left:0; bottom:0; width:100%; transition:height .55s ease; }
    .pt-tank-cap { position:absolute; top:3px; left:0; width:100%; text-align:center; font-size:9px; color:#6f7d99; }
    .pt-tank.active { border-color:rgba(54,224,212,.45); }
    .pt-tank.spill { border-color:rgba(255,90,60,.5); }
    .pt-tank-mf { position:absolute; inset:0; background:rgba(93,255,155,.20); opacity:0; border-radius:7px; pointer-events:none; }
    .n2-mp-host { width:100%; }

    /* bottom panels */
    .n2-bottom { display:grid; grid-template-columns:1.7fr 1fr 1fr; gap:12px; align-items:stretch; flex:1 1 auto; min-height:0; }
    .n2-bottom .n2-panel { padding:10px 14px; min-height:115px; overflow:visible; display:flex; flex-direction:column; min-width:0; }
    .n2-bp-body { display:flex; flex-direction:column; gap:11px; padding-top:8px; flex:1 1 auto; justify-content:center; }
    .n2-bp-row { display:flex; align-items:center; gap:8px; font-size:12px; }
    .n2-bp-k { width:64px; color:var(--pt-text-muted,#6f7d99); white-space:nowrap; }
    .n2-bp-track { flex:1; height:7px; background:rgba(120,150,200,.12); border-radius:4px; overflow:hidden; }
    .n2-bp-bar { display:block; height:100%; width:0; border-radius:4px; background:#5dff9b; transition:width .5s ease, background .3s; }
    .n2-bp-v { width:52px; text-align:right; font-family:ui-monospace,monospace; font-weight:700; }
    .n2-sync { display:flex; flex-direction:column; align-items:center; gap:1px; margin-top:9px; padding-top:8px; border-top:1px solid rgba(135,165,215,.16); }
    .n2-sync-lbl { font:600 9px ui-monospace,monospace; letter-spacing:1px; text-transform:uppercase; color:var(--pt-text-muted,#97A0B0); }
    .n2-sync-val { font:700 22px ui-monospace,monospace; font-variant-numeric:tabular-nums; color:var(--pt-status-good,#5dff9b); text-shadow:0 0 10px currentColor; }
    .n2-bp-late { margin-top:2px; }
    /* relay-mode: grey out BP-only dashboard areas with a covering label */
    .pt-relay-dim { position:relative; }
    .pt-relay-dim > *:not(.pt-relay-veil) { opacity:.16; filter:grayscale(1); pointer-events:none; }
    .pt-relay-veil { position:absolute; inset:0; z-index:6; display:flex; align-items:center; justify-content:center; background:rgba(10,14,22,.5); border-radius:inherit; }
    .pt-relay-veil span { font:700 10px ui-monospace,monospace; letter-spacing:1.4px; text-transform:uppercase; color:#8893a8; background:rgba(20,28,40,.82); border:1px solid rgba(150,170,210,.32); border-radius:6px; padding:5px 11px; white-space:nowrap; box-shadow:0 2px 10px rgba(0,0,0,.3); }
    .n2-bp-late .n2-bp-k { color:var(--pt-text-secondary,#9fb0d0); }
    .n2-ub-panel .pt-ub-body { overflow-y:auto; max-height:none; flex:1 1 auto; min-height:0; min-width:0; display:block; }
    .n2-pp-panel .pt-pp-body { /*peers-scroll*/ overflow-y:auto; overflow-x:hidden; max-height:200px;
      min-height:0; flex:1 1 auto; scrollbar-width:thin; scrollbar-color:rgba(120,150,200,.3) transparent; }
    .n2-pp-panel .pt-pp-body::-webkit-scrollbar { width:7px; }
    .n2-pp-panel .pt-pp-body::-webkit-scrollbar-thumb { background:rgba(120,150,200,.3); border-radius:4px; }
    .n2-pp-panel .pt-pp-body::-webkit-scrollbar-track { background:rgba(120,150,200,.06); border-radius:4px; }
    .pt-ub-vert { display:flex; gap:8px; align-items:stretch; flex-wrap:nowrap; overflow-x:auto; overflow-y:hidden; padding:10px 2px 8px; scrollbar-width:thin; scrollbar-color:rgba(120,150,200,.3) transparent; flex:1 1 auto; }
    .pt-ub-vert::-webkit-scrollbar { height:7px; }
    .pt-ub-vert::-webkit-scrollbar-thumb { background:rgba(120,150,200,.3); border-radius:4px; }
    .pt-ub-vert::-webkit-scrollbar-track { background:rgba(120,150,200,.06); border-radius:4px; }
    .pt-ub-vert .pt-ub-col { flex:0 0 auto; }
    .pt-ub-col { display:flex; flex-direction:column; align-items:center; gap:4px; width:44px; }
    .pt-ub-col-idx { font-size:10px; font-weight:700; color:var(--pt-text-secondary,#9fb0d0); }
    .pt-ub-col-track { position:relative; width:15px; flex:1 1 auto; min-height:40px; background:rgba(120,150,200,.12); border-radius:8px; overflow:hidden; border:1px solid rgba(120,150,200,.22); }
    .pt-ub-col-bar { position:absolute; left:0; bottom:0; width:100%; background:linear-gradient(180deg,#36e0d4,#1aa6cf); box-shadow:0 0 10px rgba(54,224,212,.5); transition:height .3s ease; }
    .pt-ub-col-eta { font-size:11px; font-family:ui-monospace,monospace; font-weight:700; color:#cdd9f0; white-space:nowrap; }
    .pt-ub-col-day { font-size:8.5px; color:var(--pt-text-muted,#6f7d99); text-align:center; white-space:nowrap; line-height:1.25; }
    .pt-ub-col-time { font-size:9px; color:var(--pt-text-secondary,#9fb0d0); text-align:center; white-space:nowrap; font-family:ui-monospace,monospace; line-height:1.25; }

    @media (max-width:1050px){
      .n2-hero-main{flex-wrap:wrap;}
      .n2-blockbox{width:100%;border-right:none;padding-right:0;border-bottom:1px solid rgba(120,150,200,.12);padding-bottom:10px;}
      .n2-deck{grid-template-columns:1fr 1fr;}
      .n2-bottom{grid-template-columns:1fr;}
    }
  </style>

  <div class="n2-wrap">

    <div class="n2-panel n2-hero">
      <div class="n2-hero-strip">
        <div class="n2-tipline">
          <span class="n2-attip" id="cp-attip">—</span>
          <span class="n2-tip-sep">&#9474;</span>
          <span><span class="pt-muted">block</span>&nbsp;<span id="cp-tipblock">—</span></span>
          <span class="n2-tip-sep">&#9474;</span>
          <span><span class="pt-muted">slot</span>&nbsp;<span id="cp-slot">—</span></span>
          <span class="n2-tip-sep">&#9474;</span>
          <span><span class="pt-muted">ep-slot</span>&nbsp;<span id="cp-epslot">—</span></span>
        </div>
        <div class="n2-poll">
          <span class="pt-cp-controls-label n2-lbl">Poll</span>
          <span class="pt-cp-tabs" id="cp-tabs">
            <span class="pt-cp-tab" data-window="10">10s</span>
            <span class="pt-cp-tab" data-window="30">30s</span>
            <span class="pt-cp-tab" data-window="60">1m</span>
            <span class="pt-cp-tab" data-window="300">5m</span>
            <span class="pt-cp-tab" data-window="900">15m</span>
            <span class="pt-cp-tab" data-window="3600">1h</span>
          </span>
        </div>
      </div>

      <div class="n2-hero-main">
        <div class="n2-blockbox">
          <div class="n2-bb-grid">
            <span class="n2-bb-stat" id="hero-blocks"><span class="k">Blocks</span><span class="v" id="hero-blocks-val" style="color:#36e0d4">—</span><span class="s" id="hero-blocks-sub">lifetime</span></span>
            <span class="n2-bb-stat" id="hero-leader"><span class="k">Leader</span><span class="v" id="hero-leader-val" style="color:#36e0d4">—</span></span>
            <span class="n2-bb-stat" id="hero-ideal"><span class="k">Ideal</span><span class="v" id="hero-ideal-val">—</span></span>
            <span class="n2-bb-stat" id="hero-adopt"><span class="k">Adopted</span><span class="v" id="hero-adopt-val" style="color:#5dff9b">—</span><span class="s" id="hero-adopt-sub"></span></span>
            <span class="n2-bb-stat" id="hero-conf"><span class="k">Confirmed</span><span class="v" id="hero-conf-val" style="color:#5dff9b">—</span></span>
            <span class="n2-bb-stat" id="hero-lost"><span class="k">Lost</span><span class="v" id="hero-lost-val">—</span></span>
          </div>
        </div>

        <div class="n2-hero-trace">
          <svg class="pt-cp-heartbeat" id="cp-heartbeat" viewBox="0 0 600 120" preserveAspectRatio="none" style="height:104px;width:100%;display:block;"></svg>
        </div>

        <div class="n2-hero-health" title="Health - overall node health score (0-100): sync, tip freshness, peers, KES.">
          <div class="v" id="hero-pulse-val">—</div>
          <div class="u">HEALTH /100</div>
          <div class="d" id="hero-pulse-delta">—</div>
        </div>
      </div>

      <span id="cp-since" style="display:none"></span><span id="cp-progress-fill" style="display:none"></span>
    </div>

    <div class="n2-deck">
      <div class="n2-panel n2-cell" id="hero-kes">
        <div class="n2-lbl">KES</div>
        ${thermoHTML({ id: 'n2-kes', color: '#ffc24a', ticks: [{ frac: 0, label: '0' }, { frac: 0.5, label: '45' }, { frac: 1, label: '90' }] })}
        <div class="n2-val" id="hero-kes-val" style="color:#ffc24a">—</div>
        <div class="n2-sub" id="hero-kes-sub">—</div>
        <div class="n2-sub" id="hero-kes-opcert" title="Operational certificate counter: on disk vs on chain (node protocol state). Healthy when they match, or disk is one ahead just after a KES rotation."><!--/*opcert-label*/--><span style="font-size:9px;letter-spacing:.6px;text-transform:uppercase;color:var(--pt-text-muted,#97A0B0);margin-right:5px;">opcert</span><span id="hero-kes-opcert-val">— on disk · — on chain</span></div>
        <div id="hero-kes-bar" style="display:none"></div>
      </div>

      <div class="n2-panel n2-cell">
        <div class="n2-lbl">Density</div>
        <div id="n2-density-dial">${speedoSVG({ id: 'n2-density', min: 0, max: 10, ticks: 10, major: 5, color: '#36e0d4' })}</div>
        <div class="n2-val" id="n2-density-read" style="color:#36e0d4">—</div>
        <div class="n2-sub" id="n2-density-sub">density (5m)</div>
        <div class="n2-density-grid">
          <span><span class="pt-muted">1m</span>&nbsp;<span id="cp-d-m1">—</span></span>
          <span><span class="pt-muted">5m</span>&nbsp;<span id="cp-d-m5">—</span></span>
          <span><span class="pt-muted">20m</span>&nbsp;<span id="cp-d-m20">—</span></span>
          <span><span class="pt-muted">1h</span>&nbsp;<span id="cp-d-h1">—</span></span>
          <span><span class="pt-muted">1d</span>&nbsp;<span id="cp-d-d1">—</span></span>
          <span><span class="pt-muted">epoch</span>&nbsp;<span id="cp-d-epoch">—</span></span>
        </div>
        <div class="n2-gaps">
          <div class="n2-gaps-head" id="cp-blockcount">—</div>
          <div class="n2-gap-row"><span class="n2-gap-lbl">avg</span><span class="n2-gap-track"><span class="n2-gap-fill" id="cp-bar-avg" style="background:#36e0d4"></span></span><span class="n2-gap-val" id="cp-avg">—</span></div>
          <div class="n2-gap-row"><span class="n2-gap-lbl">max</span><span class="n2-gap-track"><span class="n2-gap-fill" id="cp-bar-max" style="background:#ffc24a"></span></span><span class="n2-gap-val" id="cp-max">—</span></div>
          <div class="n2-gap-row"><span class="n2-gap-lbl">min</span><span class="n2-gap-track"><span class="n2-gap-fill" id="cp-bar-min" style="background:#5dff9b"></span></span><span class="n2-gap-val" id="cp-min">—</span></div>
        </div>
      </div>

      <div class="n2-panel n2-cell">
        <div class="n2-lbl" style="align-self:flex-start">Mempool</div>
        <div class="n2-mp-host pt-grid-mempool" id="n2-mp-host">
          <div class="pt-panel-meta" style="text-align:center;margin-bottom:6px;font-size:12px;"><span id="mp-count">—</span></div>
          ${tanksHTML({ ntanks: 3 })}
          <div id="n2-mp-tankpct" style="text-align:center;font-family:ui-monospace,monospace;font-weight:700;font-size:20px;color:#36e0d4;margin:6px 0 0;">—</div>
          <div style="text-align:center;font-family:ui-monospace,monospace;font-size:10px;color:var(--pt-text-muted,#97A0B0);margin:0 0 5px;letter-spacing:0.3px;">100% = 88 KB</div>
          <div id="mp-body"></div>
        </div>
      </div>

      <div class="n2-panel n2-cell">
        <div class="n2-lbl">Tip diff</div>
        <div id="n2-tip-dial">${speedoSVG({ id: 'n2-tip', min: 0, max: 120, ticks: 12, major: 4, color: '#5dff9b', redFrom: 0.75 })}</div>
        <div class="n2-val" id="n2-tip-read" style="color:#5dff9b">—</div>
        <div class="n2-sub">redline 1m 30s</div>
        <div class="n2-sync" id="n2-sync-wrap">
          <span class="n2-sync-lbl">SYNC</span>
          <span class="n2-sync-val" id="n2-sync">—</span>
        </div>
      </div>

      <div class="n2-panel n2-cell" id="hero-epoch">
        <div class="n2-lbl">Epoch</div>
        ${thermoHTML({ id: 'n2-epoch', color: '#7aa6ff', ticks: [{ frac: 0.25, label: '25' }, { frac: 0.5, label: '50' }, { frac: 0.75, label: '75' }] })}
        <div class="n2-val" id="hero-epoch-val" style="color:#7aa6ff">—</div>
        <div class="n2-epcd" id="n2-epcd"><!--/*epcd-ui*/-->
          <style>
            .n2-epcd{display:flex;flex-direction:column;gap:3px;margin-top:6px;width:100%;padding:0 8px;box-sizing:border-box;}
            .n2-epcd-row{display:flex;align-items:baseline;justify-content:space-between;}
            .n2-epcd-k{font:600 10px ui-monospace,monospace;letter-spacing:.5px;text-transform:uppercase;color:var(--pt-text-muted,#97A0B0);}
            .n2-epcd-v{font:700 17px ui-monospace,monospace;font-variant-numeric:tabular-nums;min-width:2ch;text-align:right;text-shadow:0 0 8px currentColor;}
            .n2-epcd-cap{margin-top:5px;text-align:center;font:10px ui-monospace,monospace;color:var(--pt-text-muted,#97A0B0);letter-spacing:.3px;text-transform:uppercase;}
          </style>
          <div class="n2-epcd-row"><span class="n2-epcd-k">Days</span><span class="n2-epcd-v" id="n2-ep-d" style="color:#7aa6ff">—</span></div>
          <div class="n2-epcd-row"><span class="n2-epcd-k">Hours</span><span class="n2-epcd-v" id="n2-ep-h" style="color:#36e0d4">—</span></div>
          <div class="n2-epcd-row"><span class="n2-epcd-k">Minutes</span><span class="n2-epcd-v" id="n2-ep-m" style="color:#ffc24a">—</span></div>
          <div class="n2-epcd-row"><span class="n2-epcd-k">Seconds</span><span class="n2-epcd-v" id="n2-ep-s" style="color:#5dff9b">—</span></div>
          <div class="n2-epcd-cap" id="n2-ep-cap">to epoch end</div>
        </div>
        <div id="hero-epoch-bar" style="display:none"></div>
      </div>
    </div>

    <div class="n2-bottom">
      <div class="n2-panel n2-ub-panel">
        <div class="pt-panel-header" style="display:flex;justify-content:space-between;">
          <span class="pt-panel-title" title="Your assigned leader slots for this and next epoch, computed by cardano-cli query leadership-schedule (needs the pool VRF signing key and node socket). Empty if you have no slots, or if that schedule cannot be computed on this connection. Does not use cncli.">Upcoming blocks</span>
          <span class="pt-panel-meta"><span id="ub-count" class="pt-muted">—</span></span>
        </div>
        <div class="pt-ub-body" id="ub-body"></div>
      </div>
      <div class="n2-panel n2-bp-panel">
        <div class="pt-panel-header"><span class="pt-panel-title">Block propagation</span></div>
        <div class="n2-bp-body">
          <div class="n2-bp-row"><span class="n2-bp-k">within 1s</span><span class="n2-bp-track"><span class="n2-bp-bar" id="bp-bar1"></span></span><span class="n2-bp-v" id="bp-cdf1">&mdash;</span></div>
          <div class="n2-bp-row"><span class="n2-bp-k">within 3s</span><span class="n2-bp-track"><span class="n2-bp-bar" id="bp-bar3"></span></span><span class="n2-bp-v" id="bp-cdf3">&mdash;</span></div>
          <div class="n2-bp-row"><span class="n2-bp-k">within 5s</span><span class="n2-bp-track"><span class="n2-bp-bar" id="bp-bar5"></span></span><span class="n2-bp-v" id="bp-cdf5">&mdash;</span></div>
          <div class="n2-bp-row n2-bp-late"><span class="n2-bp-k">last block</span><span class="n2-bp-v" id="bp-last">&mdash;</span></div>
        </div>
      </div>
      <div class="n2-panel n2-pp-panel">
        <div class="pt-panel-header" style="display:flex;justify-content:space-between;">
          <span class="pt-panel-title">Peers</span>
          <span class="pt-panel-meta" style="gap:6px;">
            <span class="pt-muted">out</span>&nbsp;<span id="pp-out">—</span>
            <span class="pt-muted">in</span>&nbsp;<span id="pp-in">—</span>
            <span class="pt-muted">bidir</span>&nbsp;<span id="pp-bidir">—</span>
            <span class="pt-muted">prn</span>&nbsp;<span id="pp-duplex">—</span>
          </span>
        </div>
        <div class="pt-pp-body" id="pp-body"></div>
      </div>
    </div>

  </div>
`;

function numFrom(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  const m = (el.textContent || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

// "4s" | "1m 30s" | "2m" -> seconds
function tipSeconds() {
  const el = document.getElementById('cp-since');
  if (!el) return null;
  const t = (el.textContent || '').toLowerCase();
  let sec = 0, found = false;
  const mm = t.match(/(\d+)\s*m/); if (mm) { sec += parseInt(mm[1], 10) * 60; found = true; }
  const ss = t.match(/(\d+)\s*s/); if (ss) { sec += parseInt(ss[1], 10); found = true; }
  return found ? sec : null;
}

function winLabel(sec) {
  return ({ 10: '10s', 30: '30s', 60: '1m', 300: '5m', 900: '15m', 3600: '1h' })[sec] || (sec + 's');
}

function setBP(id, txt, color) {
  const el = document.getElementById(id);
  if (el) { el.textContent = txt; if (color) el.style.color = color; }
}
function propColor(v) { return v >= 0.95 ? '#5dff9b' : v >= 0.85 ? '#ffc24a' : '#ff5a3c'; }
function renderProp() {
  const m = getLastMetrics();
  let c1, c3, c5, last;
  if (m && m.blockDelayCdfOne != null) {
    c1 = m.blockDelayCdfOne; c3 = m.blockDelayCdfThree; c5 = m.blockDelayCdfFive; last = m.blockDelayLast;
  } else if (getMode() === 'demo') {
    c1 = 0.992; c3 = 1; c5 = 1; last = 0.31;
  } else {
    setBP('bp-cdf1', '\u2014'); setBP('bp-cdf3', '\u2014'); setBP('bp-cdf5', '\u2014'); setBP('bp-last', '\u2014');
    return;
  }
  const fmtPct = v => v == null ? '\u2014' : (v * 100 >= 99.95 ? '100%' : (v * 100).toFixed(1) + '%');
  for (const [vid, bid, v] of [['bp-cdf1', 'bp-bar1', c1], ['bp-cdf3', 'bp-bar3', c3], ['bp-cdf5', 'bp-bar5', c5]]) {
    setBP(vid, fmtPct(v), v == null ? null : propColor(v));
    const bar = document.getElementById(bid);
    if (bar && v != null) { bar.style.width = Math.min(100, v * 100).toFixed(1) + '%'; bar.style.background = propColor(v); }
  }
  const lastColor = last == null ? '#9fb0d0' : last < 1 ? '#5dff9b' : last < 3 ? '#ffc24a' : '#ff5a3c';
  setBP('bp-last', last == null ? '\u2014' : last.toFixed(2) + 's', lastColor);
}

// Relay Only Mode: dim BP-only dashboard areas (block stats, KES, upcoming
// blocks) and show a covering label. Idempotent; called each paint so it
// self-applies once the node role resolves. /*relay-mode*/
const RELAY_DIM_TARGETS = ['.n2-blockbox', '#hero-kes', '.n2-ub-panel'];
function applyRelayMode() {
  let relay = false;
  try { relay = isRelayConfirmed(); } catch { relay = false; }
  RELAY_DIM_TARGETS.forEach((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    let veil = el.querySelector(':scope > .pt-relay-veil');
    if (relay) {
      el.classList.add('pt-relay-dim');
      if (!veil) {
        veil = document.createElement('div');
        veil.className = 'pt-relay-veil';
        veil.innerHTML = '<span>Relay Only Mode</span>';
        el.appendChild(veil);
      }
    } else {
      el.classList.remove('pt-relay-dim');
      if (veil) veil.remove();
    }
  });
}
function paintGauges() {
  const root = document;
  applyRelayMode();
  // Lift the loading overlay once the first real data has arrived. Demo mode
  // has no node Prometheus metrics (getLastMetrics stays null) but does fill the
  // dashboard from its snapshot, so treat demo as ready or it hangs forever.
  if (!_n2Ready) {
    let haveData = false;
    try { haveData = getMode() === 'demo' || getLastMetrics() != null; } catch (e) { haveData = false; }
    if (haveData) {
      _n2Ready = true;
      const ov = document.getElementById('n2-loading');
      if (ov) { ov.classList.add('fade'); setTimeout(() => ov.remove(), 400); }
    }
  }
  // KES thermometer: days remaining out of ~90, colour-coded (green >30, amber 10-30, red <10)
  const kes = numFrom('hero-kes-val');
  if (kes != null) {
    const kesCol = kes > 30 ? '#5dff9b' : (kes >= 10 ? '#ffc24a' : '#ff5a5a');
    setThermo(root, 'n2-kes', kes / 90, kesCol);
    const kv = root.querySelector('#hero-kes-val'); if (kv) kv.style.color = kesCol;
  }
  // Op cert counters (disk/chain) - gLiveView health rule: green when disk == chain
  // or disk == chain+1 (rotated, not yet minted with); red otherwise.
  const oc = root.querySelector('#hero-kes-opcert');
  if (oc) {
    const pr = getNodeProbe() || {};
    const d = pr.opCertDisk, c = pr.opCertChain;
    const ocv = oc.querySelector('#hero-kes-opcert-val') || oc;
    if (Number.isFinite(d) && Number.isFinite(c)) {
      const ok = (d === c) || (d === c + 1);
      ocv.textContent = `${d} on disk · ${c} on chain`;
      ocv.style.color = ok ? '#5dff9b' : '#ff5a5a';
      oc.title = ok
        ? `Operational certificate counter healthy: disk ${d}, chain ${c}.`
        : `Operational certificate counter MISMATCH: disk ${d}, chain ${c}. Expected disk == chain or one ahead.`;
    } else if (pr.role && pr.role !== 'BP') {
      oc.textContent = '';   // relays have no op cert
    } else {
      ocv.textContent = '— on disk · — on chain';
      ocv.style.color = '';
    }
  }
  // Epoch thermometer: percent
  const ep = numFrom('hero-epoch-val');
  if (ep != null) setThermo(root, 'n2-epoch', ep / 100);
  // Epoch countdown: smooth per-second tick from the stored epoch-end time
  // (now.js keeps it fresh on every snapshot). No API calls. /*epcd-tick*/
  const _epDD = document.getElementById('n2-ep-d');
  if (_epDD) {
    const _endMs = getEpochEndMs();
    if (_endMs == null) {
      ['n2-ep-d','n2-ep-h','n2-ep-m','n2-ep-s'].forEach(id => { const e = document.getElementById(id); if (e) e.textContent = '\u2014'; });
    } else {
      const _s = Math.max(0, Math.round((_endMs - Date.now()) / 1000));
      const _d = Math.floor(_s / 86400), _h = Math.floor((_s % 86400) / 3600), _m = Math.floor((_s % 3600) / 60), _ss = _s % 60;
      _epDD.textContent = _d;
      document.getElementById('n2-ep-h').textContent = _h;
      document.getElementById('n2-ep-m').textContent = _m;
      document.getElementById('n2-ep-s').textContent = String(_ss).padStart(2, '0');
      const _cap = document.getElementById('n2-ep-cap'); if (_cap) _cap.textContent = _s === 0 ? 'epoch boundary' : 'to epoch end';
    }
  }
  // Density speedo: follows the SELECTED poll window, scale 0..10% (ideal ~5%)
  const win = getActiveWindow();
  const densPct = densityPctForWindow(win);
  setSpeedo(root, 'n2-density', densPct / 10);
  const r = document.getElementById('n2-density-read');
  if (r) {
    r.textContent = densPct.toFixed(1) + '%';
    const dist = Math.abs(densPct - 5);
    r.style.color = dist <= 0.5 ? '#5dff9b' : dist <= 1.5 ? '#ffc24a' : '#ff5a3c';
  }
  const dsub = document.getElementById('n2-density-sub');
  if (dsub) dsub.textContent = 'density (' + winLabel(win) + ')';
  // Block-gap bars (avg/max/min seconds over the window), shared scale = max gap
  const ga = numFrom('cp-avg'), gm = numFrom('cp-max'), gi = numFrom('cp-min');
  const gmax = Math.max(ga || 0, gm || 0, gi || 0, 1);
  const setBar = (id, v) => { const e = document.getElementById(id); if (e && v != null) e.style.width = Math.min(100, (v / gmax) * 100).toFixed(1) + '%'; };
  setBar('cp-bar-avg', ga); setBar('cp-bar-max', gm); setBar('cp-bar-min', gi);
  // Mempool tanks: drive from the gauge percent (100% = one block tank)
  const pctEl = root.querySelector('#mp-count .pt-mp-gauge-pct');
  if (pctEl) {
    const mpct = parseFloat((pctEl.textContent || '').replace('%', '')) || 0;
    paintTanks(root, (mpct / 100) * MP_FULL, MP_FULL, 3);
    const tp = document.getElementById('n2-mp-tankpct');
    if (tp) {
      if (mpct <= 0) { tp.textContent = 'EMPTY'; tp.style.color = '#ff3344'; }
      else { tp.textContent = Math.round(mpct) + '%'; tp.style.color = mpct >= 67 ? '#ff5a3c' : mpct >= 34 ? '#ffc24a' : '#5dff9b'; }
    }
  }
  // Mint flash: tip block advanced -> mempool drained
  const tb = numFrom('cp-tipblock');
  if (tb != null) {
    if (_lastTip != null && tb > _lastTip) flashMint(root, 3);
    _lastTip = tb;
  }
  // Tip-diff speedo: seconds behind, scale 0..120, redline 90
  const tip = tipSeconds();
  if (tip != null) {
    setSpeedo(root, 'n2-tip', tip / 120);
    const tr = document.getElementById('n2-tip-read');
    if (tr) { tr.textContent = tip + ' s'; tr.style.color = tip >= 90 ? '#ff5a3c' : '#5dff9b'; }
  }
  renderProp();
  // refresh lifetime blocks occasionally (reads cached model, cheap)
  _tick = (_tick + 1) % 20;
  if (_tick === 0) { try { refreshLifetimeBlocks(); } catch (e) { /* noop */ } }
}

export function mountNow2(canvas) {
  canvas.innerHTML = N2_HTML;
  _n2Ready = false;
  // Loading overlay until the first real data lands (avoids the empty-then-trickle
  // cold start). Cleared in paintGauges() once getLastMetrics() is non-null.
  if (!document.getElementById('n2-loading')) {
    const ov = document.createElement('div');
    ov.id = 'n2-loading';
    ov.innerHTML =
      '<style>' +
      '#n2-loading{position:absolute;inset:0;z-index:40;display:flex;flex-direction:column;' +
      'align-items:center;justify-content:center;gap:14px;background:var(--pt-bg,#0d1117);' +
      'transition:opacity .35s ease;}' +
      '#n2-loading.fade{opacity:0;pointer-events:none;}' +
      '#n2-loading .n2l-ring{width:42px;height:42px;border:3px solid rgba(123,176,245,0.25);' +
      'border-top-color:#7BB0F5;border-radius:50%;animation:n2lspin .8s linear infinite;}' +
      '#n2-loading .n2l-txt{font:600 12px ui-monospace,monospace;letter-spacing:.5px;' +
      'text-transform:uppercase;color:var(--pt-accent-blue-bright,#7BB0F5);}' +
      '#n2-loading .n2l-sub{font:11px ui-monospace,monospace;color:var(--pt-text-muted,#97A0B0);}' +
      '@keyframes n2lspin{to{transform:rotate(360deg);}}' +
      '</style>' +
      '<div class="n2l-ring"></div>' +
      '<div class="n2l-txt">Starting dashboard</div>' +
      '<div class="n2l-sub">connecting to node and fetching live data\u2026</div>' +
      '<div class="n2l-sub" style="opacity:.75;font-style:italic;">please allow up to 90 seconds to populate</div>';
    // canvas is the positioning context; ensure it can host an absolute overlay.
    if (getComputedStyle(canvas).position === 'static') canvas.style.position = 'relative';
    canvas.appendChild(ov);
  }
  try { initChainPulse(); } catch (e) { /* heartbeat renders on next tick */ }
  paintGauges();
  refreshLifetimeBlocks().catch(() => {});
  if (_mirrorTimer) clearInterval(_mirrorTimer);
  _mirrorTimer = setInterval(paintGauges, 1000);
}

export function unmountNow2() {
  if (_mirrorTimer) { clearInterval(_mirrorTimer); _mirrorTimer = null; }
  const ov = document.getElementById('n2-loading'); if (ov) ov.remove();
  try { stopChainPulse(); } catch (e) { /* noop */ }
}
