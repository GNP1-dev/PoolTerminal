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
import { speedoSVG, setSpeedo, thermoHTML, setThermo, hourglassHTML, setHourglass, tanksHTML, paintTanks, flashMint } from '../ui/now-gauges.js';
import { refreshLifetimeBlocks, getEpochEndMs, isRelayConfirmed } from './now.js';
import { getLastMetrics } from '../data/metrics-query.js';
import { getMode } from '../data/index.js';
import { getNodeProbe } from '../data/session.js';
import { attachPanelLoader, markPanelReady } from '../ui/panel-loader.js';

let _mirrorTimer = null;
let _tick = 0;
let _n2Ready = false;
let _lastTip = null;
const MP_FULL = 90112;   // bytes = one block body (mainnet maxBlockBodySize)

const N2_HTML = `
  <style>
    .n2-wrap { flex:1 1 auto; min-height:0; overflow-y:auto; overflow-x:hidden; display:flex; flex-direction:column; gap:10px; padding:2px 2px 6px; }
    .n2-panel { background:linear-gradient(180deg,#0a0f1c,#070b15); border:2px solid rgba(150,182,235,.6); border-radius:13px; box-shadow:0 1px 5px rgba(0,0,0,.45); }
    .n2-lbl { font-size:var(--pt-text-label,12px); letter-spacing:var(--pt-tracking-label,0.7px); color:var(--pt-accent-blue-bright,#7BB0F5); text-transform:uppercase; font-weight:600; }

    /* hero: slim strip + main row */
    .n2-hero { padding:8px 14px 12px; display:flex; flex-direction:column; gap:8px; }
    .n2-hero-strip { display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; padding-bottom:7px; border-bottom:1px solid rgba(135,165,215,.24); }
    .n2-tipline { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--pt-text-secondary,#9fb0d0); flex-wrap:wrap; }
    .n2-attip { font-weight:700; letter-spacing:1px; color:#5dff9b; text-shadow:0 0 8px rgba(93,255,155,.5); }
    .n2-tip-sep { color:rgba(120,150,200,.3); }
    .n2-poll { display:flex; align-items:center; gap:6px; }
    .n2-refresh { display:inline-flex; align-items:center; justify-content:center; width:24px; height:20px; padding:0; margin-left:2px; border-radius:5px; cursor:pointer; background:rgba(120,150,200,.08); border:1px solid rgba(120,150,200,.22); color:#8aa0c0; vertical-align:middle; }  /*dash-refresh-v75*/
    .n2-refresh:hover { border-color:rgba(54,224,212,.5); color:#8ff2e6; }
    .n2-refresh.spin svg { animation:n2spin .6s linear; }
    @keyframes n2spin { to { transform:rotate(360deg); } }

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
    .n2-deck { display:grid; grid-template-columns:0.75fr 0.9fr 2.2fr 0.85fr 0.75fr; gap:12px; }
    .n2-cell { padding:10px 10px 8px; display:flex; flex-direction:column; align-items:center; }
    .n2-cell .n2-lbl { margin-bottom:8px; }
    .n2-val { font-family:ui-monospace,monospace; font-weight:700; font-size:17px; margin-top:6px; }
    .n2-sub { font-size:11px; color:var(--pt-text-muted,#6f7d99); margin-top:2px; }
    /* KES cell: centre the periods/date sub-lines and the opcert block */
    #hero-kes .n2-sub { text-align:center; }
    .n2-kes-opcert { margin-top:8px; text-align:center; }
    .n2-kes-opcert-lbl { font-size:9px; letter-spacing:.6px; text-transform:uppercase; color:var(--pt-text-muted,#97A0B0); margin-bottom:3px; }
    .n2-kes-opcert-lines { font-size:11px; line-height:1.35; }
    .n2-kes-note { font-size:9px; color:var(--pt-text-muted,#6f7d99); opacity:.8; }
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
    /* KES hourglass — replaces the thermometer as a time-running-out metaphor */
    .pt-hg { position:relative; width:96px; height:126px; margin:2px auto 0; display:flex; align-items:center; justify-content:center; }
    .pt-hg-svg { width:100%; height:100%; overflow:visible; }
    .pt-hg-svg path { transition: d .6s ease, fill .3s, stroke .3s; }
    .pt-hg-svg rect[rx="2"] { transition: fill .3s; }
    /* drips are animated in-SVG via SMIL (see now-gauges.js) so they move in
       viewBox units and land on the growing bottom pile. */
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
    .n2-mpbars { display:flex; flex-direction:column; gap:14px; padding:8px 10px 12px; }   /*mp-bars-v54*/
    .n2-mpbar-head { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:5px; font:700 10px ui-monospace,monospace; letter-spacing:1.2px; color:#7f8fa8; }
    .n2-mpbar-val { font-size:12px; font-weight:700; color:#9fb0d0; letter-spacing:0; }
    .n2-mpbar-track { position:relative; height:14px; background:#0a0e15; border:1px solid #3d4d6a; border-radius:7px; overflow:hidden; box-shadow:inset 0 1px 3px rgba(0,0,0,.55); }   /*mp-bars-v49*/
    .n2-mpbar-fill { position:absolute; left:0; top:0; height:100%; width:0; border-radius:7px; background:#5dff9b; box-shadow:0 0 12px rgba(93,255,155,.4); transition:width .5s ease, background .3s; }
    .n2-mpbar-fill-flow { background:#2dd4ee; box-shadow:0 0 12px rgba(45,212,238,.45); }
    .n2-mpbar-alert { visibility:hidden; height:12px; line-height:12px; color:#ff5a3c; font:700 9px ui-monospace,monospace; letter-spacing:1.2px; text-align:center; margin:1px 0 2px; text-shadow:0 0 6px rgba(255,90,60,.5); }
    .n2-mpbar-alert.on { visibility:visible; }
    .n2-mpbar-mark { position:absolute; top:0; height:100%; width:2px; background:#ffcf5a; box-shadow:0 0 5px rgba(255,207,90,.9); z-index:3; }
    .n2-mpbar-ticks { display:flex; justify-content:space-between; margin-top:4px; font:9px ui-monospace,monospace; color:#6f7d99; }
    .n2-mpbar-mid { color:#97a0b0; }
    #mp-cell { align-items:stretch; }
    .n2-mp-host { width:100%; flex:1 1 auto; display:flex; flex-direction:column; }
    .n2-mp-split { display:flex; gap:12px; align-items:stretch; flex:1 1 auto; min-height:0; }
    .n2-mp-left { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; }
    .n2-mp-left #mp-body { flex:1 1 auto; min-height:120px; display:flex; flex-direction:column; }
    .n2-mp-left #mp-body .pt-mp-spark { flex:1 1 auto; min-height:120px; height:auto; }
    .n2-mp-right { flex:0 0 120px; display:flex; flex-direction:column; gap:0; padding-left:14px; border-left:1px solid rgba(135,165,215,.14); }
    .n2-mpsc { display:flex; justify-content:space-between; align-items:baseline; padding:4px 0; gap:8px; }
    .n2-mpsc-l { font:600 9px ui-monospace,monospace; letter-spacing:.6px; text-transform:uppercase; color:#7f8fa8; white-space:nowrap; }
    .n2-mpsc-v { font:700 12px ui-monospace,monospace; color:#cfe0ff; white-space:nowrap; text-align:right; }
    .n2-mpsc-div { height:1px; background:rgba(135,165,215,.18); margin:8px 0; }
    .n2-mpsc-max { font:700 9px ui-monospace,monospace; letter-spacing:1px; color:#6f7d99; margin-bottom:3px; }
    /* headline 4-stat row (txs · size · blocks · %full) */
    .pt-mp-stats { display:flex; justify-content:space-around; align-items:stretch; gap:4px; }
    .pt-mp-stat { display:flex; flex-direction:column; align-items:center; flex:1; padding:3px 2px; }
    .pt-mp-stat b { font:800 15px ui-monospace,monospace; color:#e8eefc; line-height:1.1; }
    .pt-mp-stat i { font:600 8px ui-monospace,monospace; letter-spacing:1px; text-transform:uppercase; color:#7f8fa8; font-style:normal; margin-top:2px; }
    .pt-mp-stat.pt-mp-good b { color:#5dff9b; }
    .pt-mp-stat.pt-mp-warn b { color:#ffc24a; }
    .pt-mp-stat.pt-mp-bad  b { color:#ff5a3c; }
    .pt-mp-overflow { display:block; text-align:center; margin-top:3px; font:700 9px ui-monospace,monospace; color:#fca5a5; letter-spacing:.5px; }

    /* bottom panels */
    .n2-bottom { display:grid; grid-template-columns:1.3fr 0.85fr 0.85fr 1.2fr; gap:12px; align-items:stretch; flex:1 1 auto; min-height:0; }  /*mf-layout-v66*//*mf-viewport-v66c*/
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
    .n2-bp-body { gap:8px; }
    .n2-bp-obs .n2-bp-bar { background:#7bb0f5; }
    .n2-bp-striparea { position:relative; margin-top:6px; padding-right:46px; }
    .n2-bp-strip { display:flex; align-items:flex-end; gap:2px; height:46px; }
    .n2-bp-1sline { position:absolute; left:0; right:46px; top:22%; border-top:1px dotted var(--pt-text-muted,#6f7d99); opacity:.7; pointer-events:none; }
    .n2-bp-1slabel { position:absolute; right:2px; top:22%; transform:translateY(-50%); font:600 8px ui-monospace,monospace; color:var(--pt-text-muted,#6f7d99); letter-spacing:.3px; }
    .n2-bp-overlabel { position:absolute; left:2px; top:1px; font:600 8px ui-monospace,monospace; color:var(--pt-status-warn,#ffc24a); letter-spacing:.3px; }
    .n2-bp-tick { flex:1 1 0; min-width:2px; border-radius:2px 2px 0 0; opacity:.85; height:10%; }
    .n2-bp-strip-empty { font-size:10px; color:var(--pt-text-muted,#6f7d99); align-self:center; margin:auto; }
    .n2-bp-note { font-size:9px; color:var(--pt-text-muted,#6f7d99); text-align:center; margin-top:4px; line-height:1.3; }
    .n2-bp-history-btn { margin-top:8px; width:100%; background:var(--pt-bg-strip,#161b24); border:0.5px solid var(--pt-border,#2a3340); border-radius:6px; color:var(--pt-accent-blue-bright,#7BB0F5); cursor:pointer; font:600 10px ui-monospace,monospace; text-transform:uppercase; letter-spacing:0.5px; padding:7px; transition:border-color 0.12s,color 0.12s; }
    .n2-bp-history-btn:hover { border-color:var(--pt-accent-blue-bright,#7BB0F5); color:#fff; }
    .n2-ub-panel .pt-ub-body { overflow-y:auto; overflow-x:hidden; max-height:none; flex:1 1 auto; min-height:0; min-width:0; display:block; }  /*mf-refine-v66b*/
    .n2-ub-panel .pt-ub-body::-webkit-scrollbar { width:7px; }
    .n2-ub-panel .pt-ub-body::-webkit-scrollbar-thumb { background:rgba(120,150,200,.3); border-radius:4px; }
    .n2-ub-panel .pt-ub-body::-webkit-scrollbar-track { background:rgba(120,150,200,.06); border-radius:4px; }
    .n2-pp-panel .pt-pp-body { /*peers-scroll*/ overflow-y:auto; overflow-x:hidden; max-height:none;   /*mf-refine2-v66e*/
      min-height:0; flex:1 1 auto; scrollbar-width:thin; scrollbar-color:rgba(120,150,200,.3) transparent; }
    .n2-pp-panel .pt-pp-body::-webkit-scrollbar { width:7px; }
    .n2-pp-panel .pt-pp-body::-webkit-scrollbar-thumb { background:rgba(120,150,200,.3); border-radius:4px; }
    .n2-pp-panel .pt-pp-body::-webkit-scrollbar-track { background:rgba(120,150,200,.06); border-radius:4px; }
    /* Chain messages feed (mf-layout-v66) */
    .n2-mf-panel { min-width:0; }
    .n2-mf-body { overflow-y:auto; overflow-x:hidden; flex:1 1 auto; min-height:0; display:flex; flex-direction:column; gap:5px; padding-top:6px; position:relative; scrollbar-width:thin; scrollbar-color:rgba(120,150,200,.3) transparent; }  /*mf-faithful-v67b*/
    .n2-mf-body::-webkit-scrollbar { width:7px; }
    .n2-mf-body::-webkit-scrollbar-thumb { background:rgba(120,150,200,.3); border-radius:4px; }
    .n2-mf-body::-webkit-scrollbar-track { background:rgba(120,150,200,.06); border-radius:4px; }
    .n2-mf-msg { font-size:11px; line-height:1.3; color:#c8d4ea; border-left:2px solid rgba(120,150,200,.35); padding:2px 0 3px 8px; min-width:0; }
    .n2-mf-text { white-space:pre-wrap; word-break:break-word; display:block; }
    .n2-mf-tx { font-family:ui-monospace,monospace; font-size:8.5px; color:#6f7d99; display:block; margin-top:1px; }
    .n2-mf-msg.n2-mf-mine { border-left-color:#36e0d4; }
    .n2-mf-msg.n2-mf-mine .n2-mf-text { color:#8ff2e6; }
    @keyframes mfIn { from { opacity:0; transform:translateY(-6px); } to { opacity:1; transform:translateY(0); } }  /*mf-engine-v67*/
    /* peers header fit + feed filter toggles (mf-refine-v66b) */
    .n2-pp-panel .pt-panel-header { min-width:0; flex-wrap:nowrap; }
    .n2-pp-panel .pt-panel-meta { font-size:8px; gap:7px; white-space:nowrap; letter-spacing:-0.2px; }  /*mf-refine3-v66f*/
    .n2-pp-panel .n2-pp-pair { white-space:nowrap; }
    .n2-mf-panel .pt-panel-header { gap:6px; align-items:center; flex-wrap:nowrap; min-width:0; }
    .n2-mf-filters { display:flex; align-items:center; flex:0 0 auto; position:relative; }  /*mf-refine2-v66e*/
    .n2-mf-funnel { display:flex; align-items:center; justify-content:center; width:22px; height:16px; margin:-2px 0; padding:0; border-radius:5px;
      cursor:pointer; background:rgba(120,150,200,.08); border:1px solid rgba(120,150,200,.22); color:#8aa0c0; }
    .n2-mf-funnel:hover { border-color:rgba(120,150,200,.45); color:#c8d4ea; }
    .n2-mf-funnel.active { background:rgba(54,224,212,.14); border-color:rgba(54,224,212,.5); color:#8ff2e6; }
    .n2-mf-pause { display:flex; align-items:center; justify-content:center; width:22px; height:16px; margin:-2px 6px -2px 0; padding:0; border-radius:5px; cursor:pointer; background:rgba(120,150,200,.08); border:1px solid rgba(120,150,200,.22); color:#8aa0c0; }
    .n2-mf-pause:hover { border-color:rgba(120,150,200,.45); color:#c8d4ea; }
    .n2-mf-pause.paused { background:rgba(255,196,74,.14); border-color:rgba(255,196,74,.5); color:#ffcf5a; }
    .n2-mf-pause .mf-ic-play { display:none; }
    .n2-mf-pause.paused .mf-ic-pause { display:none; }
    .n2-mf-pause.paused .mf-ic-play { display:inline; }
    .n2-mf-menu { position:absolute; top:24px; right:0; z-index:30; background:#141b26; border:1px solid rgba(120,150,200,.3);
      border-radius:7px; padding:5px; display:flex; flex-direction:column; gap:1px; box-shadow:0 6px 18px rgba(0,0,0,.55); min-width:158px; }
    .n2-mf-menu[hidden] { display:none; }
    .n2-mf-opt { display:flex; align-items:center; gap:7px; font-size:10.5px; color:#c8d4ea; padding:4px 6px; border-radius:4px; cursor:pointer; white-space:nowrap; }
    .n2-mf-opt:hover { background:rgba(120,150,200,.1); }
    .n2-mf-opt input { accent-color:#36e0d4; cursor:pointer; margin:0; width:13px; height:13px; }
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
          <button type="button" class="n2-refresh" id="n2-refresh" title="Refresh dashboard display" aria-label="Refresh dashboard"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button>
        </div>
      </div>

      <div class="n2-hero-main">
        <div class="n2-blockbox" id="n2-blockbox">
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
        ${hourglassHTML({ id: 'n2-kes', color: '#ffc24a' })}
        <div class="n2-val" id="hero-kes-val" style="color:#ffc24a">—</div>
        <div class="n2-sub" id="hero-kes-sub">—</div>
        <div class="n2-kes-opcert" id="hero-kes-opcert" title="Operational certificate counter: on disk vs on chain (node protocol state). Healthy when they match, or disk is one ahead just after a KES rotation.">
          <div class="n2-kes-opcert-lbl">opcert</div>
          <div class="n2-kes-opcert-lines" id="hero-kes-opcert-val">
            <div id="hero-kes-opcert-disk">— on disk</div>
            <div id="hero-kes-opcert-chain">— on chain</div>
          </div>
        </div>
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

      <div class="n2-panel n2-cell" id="mp-cell">
        <div class="n2-lbl" style="align-self:flex-start">Mempool</div>
        <div class="n2-mp-host pt-grid-mempool" id="n2-mp-host">
          <div class="n2-mp-split">
            <div class="n2-mp-left">
              <span id="mp-count" style="display:none"></span>
              <div class="n2-mpbars">
                <div class="n2-mpbar">
                  <div class="n2-mpbar-head"><span>MEMPOOL</span><span id="mp-bar-val" class="n2-mpbar-val">— KB</span></div>
                  <div class="n2-mpbar-alert" id="mp-bar-alert">MAX BLOCK SIZE REACHED</div>
                  <div class="n2-mpbar-track"><div class="n2-mpbar-fill" id="mp-bar-fill"></div><div class="n2-mpbar-mark" style="left:50%"></div></div>
                  <div class="n2-mpbar-ticks"><span>0</span><span class="n2-mpbar-mid">1 block</span><span>2 blocks</span></div>
                </div>
                <div class="n2-mpbar">
                  <div class="n2-mpbar-head"><span>DATA FLOW</span><span id="mp-flow-val" class="n2-mpbar-val">— KB/min</span></div>
                  <div class="n2-mpbar-track"><div class="n2-mpbar-fill n2-mpbar-fill-flow" id="mp-flow-fill"></div></div>
                  <div class="n2-mpbar-ticks"><span>0</span><span>150</span><span>300 KB/min</span></div>
                </div>
              </div>
              <div id="mp-body"></div>
            </div>
            <div class="n2-mp-right" id="mp-statcol">
              <div class="n2-mpsc"><span class="n2-mpsc-l">Net 1m</span><span class="n2-mpsc-v" id="mp-stat-net">—</span></div>
              <div class="n2-mpsc"><span class="n2-mpsc-l">Tx rate 1m</span><span class="n2-mpsc-v" id="mp-stat-throughput1m">—</span></div>
              <div class="n2-mpsc"><span class="n2-mpsc-l">Tx rate 5m</span><span class="n2-mpsc-v" id="mp-stat-throughput">—</span></div>
              <div class="n2-mpsc"><span class="n2-mpsc-l">Avg tx 5m</span><span class="n2-mpsc-v" id="mp-stat-avg">—</span></div>
              <div class="n2-mpsc"><span class="n2-mpsc-l">Peak 5m</span><span class="n2-mpsc-v" id="mp-stat-peak">—</span></div>
              <div class="n2-mpsc-div"></div>
              <div class="n2-mpsc-max">MAX %</div>
              <div class="n2-mpsc"><span class="n2-mpsc-l">5m</span><span class="n2-mpsc-v" id="mp-peak-5m" style="color:#36e0d4">—</span></div>
              <div class="n2-mpsc"><span class="n2-mpsc-l">1h</span><span class="n2-mpsc-v" id="mp-peak-1h" style="color:#5dff9b">—</span></div>
              <div class="n2-mpsc"><span class="n2-mpsc-l">24h</span><span class="n2-mpsc-v" id="mp-peak-24h" style="color:#ffc24a">—</span></div>
              <div class="n2-mpsc"><span class="n2-mpsc-l">all</span><span class="n2-mpsc-v" id="mp-peak-all" style="color:#ff7a4c">—</span></div>
            </div>
          </div>
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
          <div class="n2-bp-row n2-bp-obs"><span class="n2-bp-k">within 0.2s</span><span class="n2-bp-track"><span class="n2-bp-bar" id="bp-bar02"></span></span><span class="n2-bp-v" id="bp-cdf02">&mdash;</span></div>
          <div class="n2-bp-row n2-bp-obs"><span class="n2-bp-k">within 0.5s</span><span class="n2-bp-track"><span class="n2-bp-bar" id="bp-bar05"></span></span><span class="n2-bp-v" id="bp-cdf05">&mdash;</span></div>
          <div class="n2-bp-row"><span class="n2-bp-k">within 1s</span><span class="n2-bp-track"><span class="n2-bp-bar" id="bp-bar1"></span></span><span class="n2-bp-v" id="bp-cdf1">&mdash;</span></div>
          <div class="n2-bp-row"><span class="n2-bp-k">within 3s</span><span class="n2-bp-track"><span class="n2-bp-bar" id="bp-bar3"></span></span><span class="n2-bp-v" id="bp-cdf3">&mdash;</span></div>
          <div class="n2-bp-row"><span class="n2-bp-k">within 5s</span><span class="n2-bp-track"><span class="n2-bp-bar" id="bp-bar5"></span></span><span class="n2-bp-v" id="bp-cdf5">&mdash;</span></div>
          <div class="n2-bp-row n2-bp-late"><span class="n2-bp-k">last block</span><span class="n2-bp-v" id="bp-last">&mdash;</span></div>
          <div class="n2-bp-striparea">
            <div class="n2-bp-strip" id="bp-strip"></div>
            <div class="n2-bp-1sline"></div>
            <div class="n2-bp-overlabel">1+ secs</div>
            <div class="n2-bp-1slabel">1 sec</div>
          </div>
          <div class="n2-bp-note">0.2s / 0.5s and the strip are observed live and build as blocks arrive.</div>
          <button class="n2-bp-history-btn" id="bp-see-history" type="button">See history \u2192</button>
        </div>
      </div>
      <div class="n2-panel n2-pp-panel">
        <div class="pt-panel-header" style="display:flex;justify-content:space-between;">
          <span class="pt-panel-title">Peers</span>
          <span class="pt-panel-meta">
            <span class="n2-pp-pair"><span class="pt-muted">out</span>&nbsp;<span id="pp-out">—</span></span>
            <span class="n2-pp-pair"><span class="pt-muted">in</span>&nbsp;<span id="pp-in">—</span></span>
            <span class="n2-pp-pair"><span class="pt-muted">bidir</span>&nbsp;<span id="pp-bidir">—</span></span>
            <span class="n2-pp-pair"><span class="pt-muted">prn</span>&nbsp;<span id="pp-duplex">—</span></span>
          </span>
        </div>
        <div class="pt-pp-body" id="pp-body"></div>
      </div>
      <div class="n2-panel n2-mf-panel">
        <div class="pt-panel-header" style="display:flex;justify-content:space-between;">
          <span class="pt-panel-title" title="Live CIP-20 transaction messages (metadata label 674) from across the chain, read from db-sync.">Metadata feed</span>
          <span class="pt-panel-meta n2-mf-filters">
            <button type="button" class="n2-mf-pause" id="mf-pause" title="Pause feed" aria-label="Pause feed"><svg class="mf-ic-pause" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg><svg class="mf-ic-play" width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7z"/></svg></button>
            <button type="button" class="n2-mf-funnel" id="mf-funnel" title="Filter messages" aria-label="Filter messages"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 4h18l-7 8v7l-4 2v-9z"/></svg></button>
            <div class="n2-mf-menu" id="mf-menu" hidden>
              <label class="n2-mf-opt"><input type="checkbox" data-mf="bots"> Hide bot / DEX spam</label>
              <label class="n2-mf-opt"><input type="checkbox" data-mf="clean"> Hide rude words</label>
              <label class="n2-mf-opt"><input type="checkbox" data-mf="bets"> Hide betting markets</label>
            </div>
          </span>
        </div>
        <div class="n2-mf-body" id="mf-body">
          <!-- static preview only; live drip engine is v67 /*mf-layout-v66*/ -->
          <div class="n2-mf-msg n2-mf-mine"><span class="n2-mf-text">GNP1 Zero-Fee Pool
Rebate of your share of the 170 ADA min pool fee</span><span class="n2-mf-tx">tx 962c4617…</span></div>
          <div class="n2-mf-msg"><span class="n2-mf-text">van sas ledge naar mark ledge</span><span class="n2-mf-tx">tx f113956f…</span></div>
          <div class="n2-mf-msg"><span class="n2-mf-text">Bodega Market - Buy Position
FIFA WC | Norway beats Brazil | July 5</span><span class="n2-mf-tx">tx 5020bd48…</span></div>
          <div class="n2-mf-msg"><span class="n2-mf-text">cash</span><span class="n2-mf-tx">tx cb40dfea…</span></div>
          <div class="n2-mf-msg"><span class="n2-mf-text">Surge Protocol Fee</span><span class="n2-mf-tx">tx 68f3d475…</span></div>
        </div>
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
// Rolling history of observed block-fetch delays, deduped by block number and
// persisted so the sub-second buckets and the strip build up over time. /*bp-history-v43*/
const BP_HIST_KEY = 'pt.blockdelay.hist.v1';
const BP_HIST_MAX = 120;
let _bpHist = null;
function bpHistLoad() {
  if (_bpHist) return _bpHist;
  try { _bpHist = JSON.parse(localStorage.getItem(BP_HIST_KEY)); } catch { _bpHist = null; }
  if (!_bpHist || !Array.isArray(_bpHist.items)) _bpHist = { last: null, items: [] };
  return _bpHist;
}
function bpHistRecord(blockNo, delay) {
  if (blockNo == null || delay == null) return;
  const h = bpHistLoad();
  if (h.last === blockNo) return;   // same block, already recorded
  h.last = blockNo;
  h.items.push({ b: blockNo, d: delay, t: Date.now() });
  if (h.items.length > BP_HIST_MAX) h.items = h.items.slice(-BP_HIST_MAX);
  try { localStorage.setItem(BP_HIST_KEY, JSON.stringify(h)); } catch { /* ignore */ }
}
function bpHistFrac(thresh) {
  const items = bpHistLoad().items;
  if (items.length === 0) return null;
  return items.reduce((a, x) => a + (x.d <= thresh ? 1 : 0), 0) / items.length;
}
function renderBpStrip() {
  const el = document.getElementById('bp-strip');
  if (!el) return;
  const items = bpHistLoad().items.slice(-40);
  if (items.length === 0) { el.innerHTML = '<span class="n2-bp-strip-empty">builds as blocks arrive</span>'; return; }
  // The dotted 1s reference line sits at 78% height. Blocks under 1s fill the
  // lower 0-78% band (so normal sub-second variance is clearly visible); blocks
  // at/above 1s rise into the top 'over' band (78->100% across 1..3s), capped.
  const LINE = 78;   // % height of the 1s line
  el.innerHTML = items.map((x) => {
    const col = x.d < 1 ? '#5dff9b' : x.d < 3 ? '#ffc24a' : '#ff5a3c';
    let h;
    if (x.d < 1) h = (x.d / 1.0) * LINE;
    else h = LINE + ((Math.min(x.d, 3) - 1) / 2) * (100 - LINE);
    h = Math.max(6, Math.min(100, h));
    return `<span class="n2-bp-tick" style="height:${h.toFixed(0)}%;background:${col}" title="block ${x.b}: ${x.d.toFixed(2)}s"></span>`;
  }).join('');
}
// Mempool inflow: bytes that ARRIVED in the last 60s (positive deltas only, so
// a block clearing the pool never counts as negative). Independent of block
// cadence - real fill pressure. In-memory, last minute only. /*mp-flow-v44*/
const MP_FLOW_WINDOW_MS = 60000;
const MP_FLOW_FULL_KBMIN = 300;   // KB/min = full-scale on the flow bar (tunable)
let _mpFlow = [];
function mpFlowRate(bytes) {
  if (bytes == null) return null;
  const now = Date.now();
  _mpFlow.push({ t: now, b: bytes });
  const cutoff = now - MP_FLOW_WINDOW_MS - 2000;
  while (_mpFlow.length && _mpFlow[0].t < cutoff) _mpFlow.shift();
  const winStart = now - MP_FLOW_WINDOW_MS;
  let arrivals = 0, prev = null;
  for (const s of _mpFlow) {
    if (prev != null && s.t >= winStart && s.b > prev.b) arrivals += (s.b - prev.b);
    prev = s;
  }
  return arrivals / 1024;   // KB arrived in ~60s = KB/min
}
function renderMempoolFlow(root) {
  const r = root || document;
  const m = getLastMetrics();
  let kbmin = null;
  if (m && m.mempoolBytes != null) kbmin = mpFlowRate(m.mempoolBytes);
  else if (getMode() === 'demo') kbmin = 42;
  const fill = r.querySelector('#mp-flow-fill');
  const read = document.getElementById('mp-flow-val');
  if (kbmin == null) {
    if (fill) fill.style.width = '0%';
    if (read) { read.textContent = '— KB/min'; read.style.color = '#6f7d99'; }
    return;
  }
  const frac = Math.max(0, Math.min(1, kbmin / MP_FLOW_FULL_KBMIN));
  if (fill) { fill.style.width = (frac * 100).toFixed(1) + '%'; fill.style.background = '#2dd4ee'; }
  if (read) { read.textContent = Math.round(kbmin) + ' KB/min'; read.style.color = '#2dd4ee'; }
}
function renderProp() {
  const m = getLastMetrics();
  let c1, c3, c5, last, o2, o5;
  if (m && m.blockDelayCdfOne != null) {
    c1 = m.blockDelayCdfOne; c3 = m.blockDelayCdfThree; c5 = m.blockDelayCdfFive; last = m.blockDelayLast;
    if (m.blockNum != null && last != null) bpHistRecord(m.blockNum, last);
    o2 = bpHistFrac(0.2); o5 = bpHistFrac(0.5);
  } else if (getMode() === 'demo') {
    c1 = 0.992; c3 = 1; c5 = 1; last = 0.31; o2 = 0.28; o5 = 0.74;
  } else {
    setBP('bp-cdf02', '\u2014'); setBP('bp-cdf05', '\u2014');
    setBP('bp-cdf1', '\u2014'); setBP('bp-cdf3', '\u2014'); setBP('bp-cdf5', '\u2014'); setBP('bp-last', '\u2014');
    renderBpStrip();
    return;
  }
  const fmtPct = v => v == null ? '\u2014' : (v * 100 >= 99.95 ? '100%' : (v * 100).toFixed(1) + '%');
  for (const [vid, bid, v] of [['bp-cdf1', 'bp-bar1', c1], ['bp-cdf3', 'bp-bar3', c3], ['bp-cdf5', 'bp-bar5', c5]]) {
    setBP(vid, fmtPct(v), v == null ? null : propColor(v));
    const bar = document.getElementById(bid);
    if (bar && v != null) { bar.style.width = Math.min(100, v * 100).toFixed(1) + '%'; bar.style.background = propColor(v); }
  }
  // Observed sub-second buckets (accent blue - built from recorded delays).
  for (const [vid, bid, v] of [['bp-cdf02', 'bp-bar02', o2], ['bp-cdf05', 'bp-bar05', o5]]) {
    setBP(vid, v == null ? '\u2014' : fmtPct(v), '#7bb0f5');
    const bar = document.getElementById(bid);
    if (bar) { bar.style.width = (v == null ? 0 : Math.min(100, v * 100)).toFixed(1) + '%'; bar.style.background = '#7bb0f5'; }
  }
  const lastColor = last == null ? '#9fb0d0' : last < 1 ? '#5dff9b' : last < 3 ? '#ffc24a' : '#ff5a3c';
  setBP('bp-last', last == null ? '\u2014' : last.toFixed(2) + 's', lastColor);
  renderBpStrip();
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
  // Per-panel spinners: check each panel's readiness probe and reveal the ones
  // whose data has arrived. Runs every tick (1s) alongside the rest of paint.
  try { tickPanelLoaders(); } catch (e) { /* non-critical */ }
  // KES hourglass: driven by DAYS remaining (the value shown) out of a full KES
  // lifetime of ~93 days (62 periods x ~1.5 days). So 47 days => ~half full,
  // matching the periods reading (32/62). Colours are day-based: green >21 days
  // (~2 weeks warning), amber 7-21, red <7 (rotate now).
  const KES_TOTAL_DAYS = 93;
  // Prefer the stable expiry timestamp (set by now-hero) so the glass drains
  // continuously and monotonically; fall back to the integer days text if it's
  // absent (e.g. cli gave no expiry). daysLeft is fractional in the first case.
  const kv = root.querySelector('#hero-kes-val');
  const expiryUnix = kv ? parseFloat(kv.dataset.kesExpiry || '') : NaN;
  let daysLeft = null;
  if (Number.isFinite(expiryUnix)) {
    daysLeft = Math.max(0, (expiryUnix - Date.now() / 1000) / 86400);
  } else {
    const kes = numFrom('hero-kes-val');
    if (kes != null) daysLeft = kes;
  }
  if (daysLeft != null) {
    const kesCol = daysLeft > 21 ? '#5dff9b' : (daysLeft >= 7 ? '#ffc24a' : '#ff5a5a');
    setHourglass(root, 'n2-kes', daysLeft / KES_TOTAL_DAYS, kesCol);
    if (kv) kv.style.color = kesCol;
  }
  // Op cert counters (disk/chain) - gLiveView health rule: green when disk == chain
  // or disk == chain+1 (rotated, not yet minted with); red otherwise.
  const oc = root.querySelector('#hero-kes-opcert');
  if (oc) {
    const pr = getNodeProbe() || {};
    // In DEMO there is no node to probe, so the counters never arrive and the cell
    // read "querying node…" indefinitely — the one visibly stuck element on an
    // otherwise live-looking dashboard. Show a healthy synthetic pair instead.
    // /*demo-hero-v82*/
    const demo = getMode() === 'demo';
    const d = demo ? 26 : pr.opCertDisk, c = demo ? 26 : pr.opCertChain;
    const ocv = oc.querySelector('#hero-kes-opcert-val') || oc;
    if (Number.isFinite(d) && Number.isFinite(c)) {
      const ok = (d === c) || (d === c + 1);
      const diskEl = oc.querySelector('#hero-kes-opcert-disk');
      const chainEl = oc.querySelector('#hero-kes-opcert-chain');
      if (diskEl) diskEl.textContent = `${d} on disk`;
      if (chainEl) chainEl.textContent = `${c} on chain`;
      ocv.style.color = ok ? '#5dff9b' : '#ff5a5a';
      oc.title = ok
        ? `Operational certificate counter healthy: disk ${d}, chain ${c}.`
        : `Operational certificate counter MISMATCH: disk ${d}, chain ${c}. Expected disk == chain or one ahead.`;
    } else if (pr.role && pr.role !== 'BP') {
      oc.style.display = 'none';   // relays have no op cert
    } else {
      const diskEl = oc.querySelector('#hero-kes-opcert-disk');
      const chainEl = oc.querySelector('#hero-kes-opcert-chain');
      if (diskEl) diskEl.textContent = 'querying';
      if (chainEl) chainEl.textContent = 'node…';
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
  // Mempool bar: shows CONGESTION (backlog vs a 2-block busy reference), read
  // from the gauge the mempool panel renders. 1 block = 50%, 2 blocks = 100%.
  // The bar value line shows real bytes and blocks queued; capacity fill is
  // carried on the gauge as a data attribute. /*mp-bars-v52*/
  const statsEl = root.querySelector('#mp-count .pt-mp-stats');
  if (statsEl) {
    const txs = parseInt(statsEl.getAttribute('data-txs')) || 0;
    const bytes = parseFloat(statsEl.getAttribute('data-bytes')) || 0;
    const blocks = parseFloat(statsEl.getAttribute('data-blocks')) || 0;
    const congestion = parseFloat(statsEl.getAttribute('data-congestion')) || 0;
    const fill = document.getElementById('mp-bar-fill');   /*mp-bars-v54*/
    if (fill) {
      fill.style.width = Math.min(100, Math.max(0, congestion)).toFixed(1) + '%';
      fill.style.background = congestion >= 100 ? '#ff5a3c' : congestion >= 75 ? '#f87171' : congestion >= 50 ? '#ffc24a' : '#5dff9b';
    }
    // Full inline stat line on the MEMPOOL bar header (replaces the old top row).
    const val = document.getElementById('mp-bar-val');
    if (val) {
      const kb = bytes >= 1024 ? (bytes / 1024).toFixed(1) + ' KB' : Math.round(bytes) + ' B';
      const blkTxt = blocks < 0.1 ? '<0.1' : blocks.toFixed(1);
      val.innerHTML = `${txs} tx · ${kb} · ${blkTxt} blocks · <b style="color:${congestion >= 90 ? '#ff5a3c' : congestion >= 50 ? '#ffc24a' : '#5dff9b'}">${Math.round(congestion)}%</b>`;
      val.style.color = '#9fb0d0';
    }
    // Alert line: at/over 100% the network mempool is full and default nodes
    // reject new txs; otherwise flag when a full block's worth is queued.
    const mpAlert = document.getElementById('mp-bar-alert');   /*mp-bars-v54*/
    if (mpAlert) {
      if (congestion > 100) {
        mpAlert.textContent = `OVERFLOW ${Math.round(congestion)}% · holding more than the network accepts`;
        mpAlert.classList.add('on');
      } else if (congestion >= 100) {
        mpAlert.textContent = 'MEMPOOL FULL · network rejecting new txs';
        mpAlert.classList.add('on');
      } else if (blocks >= 1) {
        mpAlert.textContent = 'MAX BLOCK SIZE REACHED';
        mpAlert.classList.add('on');
      } else {
        mpAlert.classList.remove('on');
      }
    }
  }
  renderMempoolFlow(root);
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

// ===========================================================================
// Metadata feed - buffer-drip engine /*mf-engine-v67*/
// ===========================================================================
const MF_DENYLIST = /minswap|sundae|ssp:|dexhunter|danogo|ourodex|steelswap|secondfi|surf -|cnft tools|adder presale|dreptalk|vespr|binance|okx|aggregator|splash|vyfi|muesliswap|wingriders|cardem|masumi|surge protocol|wayup/i;   /*mf-filters2-v67c*/
const MF_BODEGA = /bodega|fifa|world cup|parlay/i;
const MF_PROFANITY = /\b(fuck\w*|shit\w*|cunt\w*|bitch\w*|asshole\w*|wanker?|bastard\w*|motherfuck\w*|bollocks|twat\w*|dickhead\w*)\b/i;
const MF_DEMO_MSGS = [
  { text: 'GNP1 Zero-Fee Pool\nRebate of your share of the 170 ADA min pool fee', tx: '962c4617aa11d3' },
  { text: 'van sas ledge naar mark ledge', tx: 'f113956fe74920' },
  { text: 'Bodega Market - Buy Position\nFIFA WC | Norway beats Brazil | July 5', tx: '5020bd4866b7a1' },
  { text: 'cash', tx: 'cb40dfea6133ee' },
  { text: 'Minswap: Order Executed', tx: '56a76d187b02cc' },
  { text: 'gm frens have a great day', tx: 'a1b2c3d4e5f601' },
  { text: 'Surge Protocol Fee', tx: '68f3d475a52799' },
  { text: 'Dexhunter Trade', tx: '0ab765ce29b7f3' },
  { text: 'thanks for the block ser', tx: '11aa22bb33cc44' },
  { text: 'Bodega Market - Buy Position\nSpain vs Portugal TOTAL OVER 2.5', tx: 'b3cac3190f35d2' },
  { text: 'wen moon', tx: 'deadbeef001122' },
  { text: 'Minswap: Cancel Order', tx: '3df51cc362cb90' },
  { text: 'GNP1 Zero-Fee Pool\nThank you for delegating', tx: '99aa88bb77cc66' },
  { text: 'proof of onboarding complete', tx: '5ed040898a9d31' },
  { text: 'sending love to the chain', tx: '7c8e9f0a1b2c3d' },
];

let _mfPollTimer = null, _mfDripTimer = null, _mfSinceId = 0, _mfBuffer = [], _mfDemo = false, _mfDemoIdx = 0, _mfPaused = false;

function mfFilters(canvas) {
  const get = (k) => { const el = canvas.querySelector('.n2-mf-menu input[data-mf="' + k + '"]'); return !!(el && el.checked); };
  return { bots: get('bots'), clean: get('clean'), bets: get('bets') };
}
function mfHidden(text, f) {
  if (f.bots && MF_DENYLIST.test(text)) return true;
  if (f.bets && MF_BODEGA.test(text)) return true;
  if (f.clean && MF_PROFANITY.test(text)) return true;
  return false;
}
function mfTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return d.getDate() + ' ' + mon + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function mfRender(canvas, msg) {
  const body = canvas.querySelector('#mf-body');
  if (!body) return;
  const div = document.createElement('div');
  div.className = 'n2-mf-msg' + (/gnp1/i.test(msg.text) ? ' n2-mf-mine' : '');
  div.style.animation = 'mfIn .45s ease';
  const t = document.createElement('span'); t.className = 'n2-mf-text'; t.textContent = msg.text;   // plain text only
  const x = document.createElement('span'); x.className = 'n2-mf-tx';
  x.textContent = (msg.tx ? ('tx ' + String(msg.tx).slice(0, 8) + '\u2026') : '') + (msg.ts ? '   \u00b7   ' + mfTime(msg.ts) : '');
  div.appendChild(t); div.appendChild(x);
  const atTop = body.scrollTop <= 4;   /*mf-faithful-v67b*/
  body.insertBefore(div, body.firstChild);
  while (body.children.length > 50) body.removeChild(body.lastChild);
  if (atTop) body.scrollTop = 0;                       // stick to top only if already there
  else body.scrollTop += div.offsetHeight + 5;         // otherwise hold the reader's position
}
function mfNext(canvas) {
  if (!_mfBuffer.length && _mfDemo) {
    for (let i = 0; i < 6; i++) {
      const m = MF_DEMO_MSGS[_mfDemoIdx % MF_DEMO_MSGS.length]; _mfDemoIdx++;
      _mfBuffer.push({ text: m.text, tx: m.tx });
    }
  }
  return _mfBuffer.shift() || null;
}
function mfDrip(canvas) {
  if (_mfPaused) return;   /*mf-filters2-v67c*/
  const f = mfFilters(canvas);
  let guard = 0, msg;
  while ((msg = mfNext(canvas)) && guard++ < 60) {
    if (!mfHidden(msg.text, f)) { mfRender(canvas, msg); return; }
  }
}
async function mfPoll(canvas) {   /*mf-faithful-v67b*/
  try {
    const dq = await import('../data/dbsync-query.js');
    if (!dq.getMessageFeed) return;
    // Self-heal: if the mount-time seed never established a watermark (db-sync
    // wasn't ready yet), seed from the NEWEST messages now rather than walking
    // ascending from id 0 (which replays the table from the beginning). /*mf-seedfix-v77*/
    if (!_mfSinceId) {
      const seed = await dq.getMessageFeed({ sinceId: 0, limit: 40, order: 'desc' });
      if (seed && seed.messages && seed.messages.length) {
        for (let i = seed.messages.length - 1; i >= 0; i--) _mfBuffer.push(seed.messages[i]);
        _mfSinceId = seed.scannedMax || 0;
      }
      return;   // watermark set; the next poll paginates forward from here
    }
    let pages = 0;
    while (pages++ < 25) {   // paginate forward from the watermark until caught up
      const res = await dq.getMessageFeed({ sinceId: _mfSinceId, limit: 200, order: 'asc' });
      if (!res || !res.messages || !res.messages.length) break;
      for (const m of res.messages) _mfBuffer.push(m);   // asc => already oldest-first
      if (res.scannedMax) _mfSinceId = Math.max(_mfSinceId, res.scannedMax);
      if (res.messages.length < 200) break;   // last page
    }
    if (_mfBuffer.length > 2000) _mfBuffer.splice(0, _mfBuffer.length - 2000);
  } catch (e) { /* db-sync not reachable yet */ }
}
function mfScheduleDrip(canvas) {   // adaptive: calm when quiet, brisk when backed up /*mf-faithful-v67b*/
  if (_mfDripTimer) clearTimeout(_mfDripTimer);
  const n = _mfBuffer.length;
  const delay = n > 40 ? 900 : n > 15 ? 1800 : 3500;
  _mfDripTimer = setTimeout(() => { try { mfDrip(canvas); } catch (e) { /* keep ticking */ } mfScheduleDrip(canvas); }, delay);
}
async function mfStart(canvas) {
  mfStop();
  _mfBuffer = []; _mfSinceId = 0; _mfDemoIdx = 0; _mfPaused = false;
  const body = canvas.querySelector('#mf-body');
  if (body) body.innerHTML = '';   // clear the static preview
  let mode = 'demo';
  try { const idx = await import('../data/index.js'); mode = idx.getMode ? idx.getMode() : 'demo'; } catch (e) { /* default demo */ }
  _mfDemo = (mode !== 'live');
  if (!_mfDemo) {
    try {
      const dq = await import('../data/dbsync-query.js');
      const seed = await dq.getMessageFeed({ sinceId: 0, limit: 40, order: 'desc' });   // newest first
      if (seed && seed.messages && seed.messages.length) {
        for (let i = seed.messages.length - 1; i >= 0; i--) _mfBuffer.push(seed.messages[i]);  // oldest-first for the drip
        _mfSinceId = seed.scannedMax || 0;
      }
    } catch (e) { /* db-sync not ready */ }
    _mfPollTimer = setInterval(() => mfPoll(canvas), 12000);
  }
  mfScheduleDrip(canvas);   /*mf-faithful-v67b*/
}
function mfStop() {
  if (_mfPollTimer) { clearInterval(_mfPollTimer); _mfPollTimer = null; }
  if (_mfDripTimer) { clearTimeout(_mfDripTimer); _mfDripTimer = null; }   /*mf-faithful-v67b*/
}

// ── Per-panel loading spinners ───────────────────────────────────────────────
// Panels reveal independently as their own data arrives. Each entry: the panel
// element selector, the spinner label, and a probe() that returns true once the
// panel holds real (non-placeholder) data. A panel with its own informative
// waiting message (Upcoming Blocks) is omitted so we don't hide that text.
let _plStart = 0;
const _PL_TIMEOUT_MS = 100000;   // safety net: lift any stuck spinner after 100s

function _txt(id) {
  const el = document.getElementById(id);
  return el ? (el.textContent || '').trim() : '';
}
function _real(id) {
  const t = _txt(id);
  return t !== '' && t !== '\u2014' && t !== '-';   // not empty, not em/hyphen dash
}

// probes return true when the panel's real data has landed
const _PANEL_LOADERS = [
  { sel: '#n2-blockbox',   label: 'Waiting for block data',
    probe: () => { const b = document.getElementById('n2-blockbox');
                   return !!b && b.getAttribute('data-ready') === '1'; } },
  { sel: '.n2-hero-trace', label: 'Waiting for chain pulse',
    probe: () => { const svg = document.getElementById('cp-heartbeat');
                   return !!svg && svg.querySelector('path') != null; } },
  { sel: '#hero-kes',      label: 'Reading KES',
    probe: () => _real('hero-kes-val') },
  { sel: '#hero-epoch',    label: 'Syncing epoch',
    probe: () => _real('n2-ep-d') || _real('n2-ep-h') || _real('n2-ep-m') },
  { selFn: () => { const h = document.getElementById('n2-mp-host');
                   return h ? h.closest('.n2-cell') : null; }, label: 'Reading mempool',
    probe: () => { const v = document.querySelector('.n2-mpbar-val');
                   return !!v && /\d/.test(v.textContent || ''); } },
  { sel: '.n2-pp-panel',   label: 'Finding peers',
    probe: () => { const b = document.querySelector('.n2-pp-panel');
                   return !!b && /\d/.test((b.textContent || '').replace(/Peers?/gi, '')); } },
  { sel: '.n2-ub-panel',   label: 'Computing leader schedule (up to 2 min)',
    probe: () => { const p = document.querySelector('.n2-ub-panel');
                   // ready when the panel exists and is NOT in the loading state.
                   // null attr = not yet rendered = still loading (keep spinner).
                   return !!p && p.getAttribute('data-ub-loading') === '0'; } },
  { sel: '.n2-mf-panel',   label: 'Waiting for metadata feed',
    probe: () => { const b = document.querySelector('.n2-mf-body');
                   return !!b && b.querySelector('.n2-mf-msg') != null; } },
];

function setupPanelLoaders(canvas) {
  _plStart = Date.now();
  for (const cfg of _PANEL_LOADERS) {
    let el = null;
    try { el = cfg.selFn ? cfg.selFn() : canvas.querySelector(cfg.sel); } catch (e) { el = null; }
    if (el) { cfg._el = el; attachPanelLoader(el, cfg.label); }
  }
}

function tickPanelLoaders() {
  const timedOut = _plStart && (Date.now() - _plStart) > _PL_TIMEOUT_MS;
  for (const cfg of _PANEL_LOADERS) {
    const el = cfg._el;
    if (!el) continue;
    let ready = false;
    try { ready = !!cfg.probe(); } catch (e) { ready = false; }
    if (ready || timedOut) markPanelReady(el);
  }
}

export function mountNow2(canvas) {
  canvas.innerHTML = N2_HTML;
  _n2Ready = false;
  // ── Per-panel loading spinners (single load process; no full-screen overlay) ──
  // Each panel shows a rotating spinner + label until ITS OWN data arrives, then
  // reveals. Panels that print their own informative waiting text (e.g. Upcoming
  // Blocks: "querying the leadership schedule…") are intentionally NOT covered.
  // A safety timeout lifts any spinner after 100s so none can get stuck.
  try { setupPanelLoaders(canvas); } catch (e) { /* loaders are non-critical */ }
  // "See history" -> jump to the Logs tab and open the propagation view
  try {
    const histBtn = canvas.querySelector('#bp-see-history');
    if (histBtn) histBtn.addEventListener('click', () => {
      try { window.__ptOpenLogsQuery = 'propagation'; } catch (e) { /* */ }
      const logsTab = document.querySelector('.pt-tab[data-view="logs"]');
      if (logsTab) logsTab.click();
    });
  } catch (e) { /* non-critical */ }
  try { initChainPulse(); } catch (e) { /* heartbeat renders on next tick */ }
  // Metadata-feed filter funnel menu. Checkbox state (checked = filter on) is
  // read by the live engine in v67. /*mf-refine2-v66e*/
  const _mfPauseBtn = canvas.querySelector('#mf-pause');   /*mf-filters2-v67c*/
  if (_mfPauseBtn) _mfPauseBtn.addEventListener('click', () => {
    _mfPaused = !_mfPaused;
    _mfPauseBtn.classList.toggle('paused', _mfPaused);
    _mfPauseBtn.title = _mfPaused ? 'Resume feed' : 'Pause feed';
  });
  const _mfFunnel = canvas.querySelector('#mf-funnel');
  const _mfMenu = canvas.querySelector('#mf-menu');
  if (_mfFunnel && _mfMenu) {
    _mfFunnel.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_mfMenu.hasAttribute('hidden')) { _mfMenu.removeAttribute('hidden'); _mfFunnel.classList.add('active'); }
      else { _mfMenu.setAttribute('hidden', ''); _mfFunnel.classList.remove('active'); }
    });
    canvas.addEventListener('click', (e) => {
      if (!_mfMenu.hasAttribute('hidden') && !_mfMenu.contains(e.target) && !_mfFunnel.contains(e.target)) {
        _mfMenu.setAttribute('hidden', ''); _mfFunnel.classList.remove('active');
      }
    });
  }
  try { mfStart(canvas); } catch (e) { /* feed engine optional */ }   /*mf-engine-v67*/
  const _n2refresh = canvas.querySelector('#n2-refresh');   /*dash-refresh-v75*/
  if (_n2refresh) _n2refresh.addEventListener('click', () => {
    _n2refresh.classList.remove('spin'); void _n2refresh.offsetWidth; _n2refresh.classList.add('spin');
    try { paintGauges(); } catch (e) { /* */ }
    try { renderProp(); } catch (e) { /* */ }
    try { renderMempoolFlow(canvas); } catch (e) { /* */ }
    try { renderBpStrip(); } catch (e) { /* */ }
    try { window.dispatchEvent(new CustomEvent('pt:refresh')); } catch (e) { /* */ }
  });
  paintGauges();
  refreshLifetimeBlocks().catch(() => {});
  if (_mirrorTimer) clearInterval(_mirrorTimer);
  _mirrorTimer = setInterval(paintGauges, 1000);
}

export function unmountNow2() {
  if (_mirrorTimer) { clearInterval(_mirrorTimer); _mirrorTimer = null; }
  try { mfStop(); } catch (e) { /* noop */ }   /*mf-engine-v67*/
  const ov = document.getElementById('n2-loading'); if (ov) ov.remove();
  try { stopChainPulse(); } catch (e) { /* noop */ }
}
