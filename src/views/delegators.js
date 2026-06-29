/**
 * PoolTerminal — DELEGATORS view (own-pool focus).
 *
 * "Who delegates to ME" — not a chain explorer. Reads through the capability
 * registry: POOL_LIVE + DELEGATOR_LIST. These are provided by the OPTIONAL
 * Blockfrost source (and, in future, db-sync). If no source can answer, the
 * view shows a friendly prompt explaining the add-on — the app is never broken
 * without it (MANUAL §4 product principle).
 *
 * Stage 1 (this file): overview — hero stats, top delegators, full list with
 * pledge/owner flagged, basic churn (delegator count vs last epoch from the
 * history cache). Stage 2 will add the per-delegator deep-dive + migration
 * visuals (DELEGATOR_DETAIL: pool-movement trail, origin, DRep).
 *
 * Layout mirrors history.js: scoped <style>, hero row, pt-panel sections.
 */

import * as readModel from '../data/read-model.js';
import { registry, DataKind } from '../data/capabilities.js';
import * as blockfrost from '../data/blockfrost-query.js';

// Our own pool — to highlight the destination node in the journey.
const OUR_POOL = 'pool1fv9f8phzn7hp623ypw6ctf73a98hd7nrh8wm7glpcuhf64856g2';
// Latest epoch, captured on mount — passed to the deep-dive so the stake-history
// cache knows which epoch is still mutable (re-fetch) vs immutable (use cache).
let _currentEpoch = null;
// Deterministic colour per pool id, so each pool keeps a consistent hue.
function poolColor(id, isUs) {
  if (isUs) return '#b8860b';
  let h = 0; for (let i = 0; i < (id || '').length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h}, 52%, 38%)`;
}

const DELEGATORS_HTML = `
  <style>
    .pt-delegators { display: flex; flex-direction: column; gap: var(--pt-gap, 8px); padding: 8px; height: 100%; overflow-y: auto; }
    .pt-delegators .pt-hero-row-5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: var(--pt-gap, 8px); }
    .pt-delegators .pt-hero-row-6 { display: grid; grid-template-columns: repeat(6, 1fr); gap: var(--pt-gap, 8px); }
    .pt-delegators .pt-hero-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pt-delegators .pt-tbl-wrap { max-height: 460px; overflow: auto; }
    .pt-delegators table { width: 100%; border-collapse: collapse; font: 400 11px ui-monospace, monospace; white-space: nowrap; }
    .pt-delegators thead th { position: sticky; top: 0; background: var(--pt-bg-strip); color: var(--pt-text-secondary);
      text-align: right; font-weight: 500; padding: 6px 10px; border-bottom: 0.5px solid var(--pt-border);
      text-transform: uppercase; letter-spacing: 0.4px; font-size: 10px; }
    .pt-delegators thead th:first-child, .pt-delegators thead th.left { text-align: left; }
    .pt-delegators tbody td { text-align: right; padding: 5px 10px; border-bottom: 0.5px solid var(--pt-border); color: var(--pt-text-primary); }
    .pt-delegators tbody td:first-child, .pt-delegators tbody td.left { text-align: left; color: var(--pt-text-secondary); }
    .pt-delegators tbody tr:hover { background: rgba(90,140,220,0.14); }
    .pt-delegators tbody tr:hover .addr { color: var(--pt-accent-blue); text-decoration: underline; }
    .pt-delegators tbody tr:hover .click-hint { opacity: 1; }
    .pt-delegators .click-hint { opacity: 0; transition: opacity 0.12s; font-size: 9px; color: var(--pt-accent-blue);
      margin-left: 8px; text-transform: uppercase; letter-spacing: 0.4px; white-space: nowrap; }
    .pt-delegators .addr { font-size: 10px; color: var(--pt-text-secondary); transition: color 0.12s; }
    .pt-delegators .badge { display: inline-block; font-size: 9px; padding: 1px 5px; border-radius: 3px; margin-left: 6px;
      text-transform: uppercase; letter-spacing: 0.4px; vertical-align: middle; }
    .pt-delegators .badge-pledge { background: rgba(214,178,70,0.18); color: var(--pt-accent-gold, #d6b246); border: 0.5px solid rgba(214,178,70,0.5); }
    .pt-delegators .bar { display: inline-block; height: 6px; background: var(--pt-accent-blue); border-radius: 2px; vertical-align: middle; }
    .pt-delegators .v-good { color: var(--pt-status-good); }
    .pt-delegators .v-warn { color: var(--pt-status-warn); }
    .pt-delegators .v-muted { color: var(--pt-text-muted); }
    .pt-delegators .pt-empty { padding: 48px 32px; text-align: center; color: var(--pt-text-muted); max-width: 560px; margin: 24px auto; }
    .pt-delegators .pt-empty h3 { color: var(--pt-text-secondary); font-weight: 600; margin: 0 0 12px; }
    .pt-delegators .pt-empty p { line-height: 1.5; margin: 8px 0; }
    .pt-delegators .pt-empty code { background: var(--pt-bg-strip); padding: 1px 5px; border-radius: 3px; font-size: 11px; }
    .pt-delegators tbody tr { cursor: pointer; }

    /* Loading overlay + staged progress bar */
    .d-load { padding: 52px 32px 56px; max-width: 440px; margin: 28px auto; text-align: center; }
    .d-load-title { font: 600 13px ui-monospace, monospace; color: var(--pt-text-secondary);
      text-transform: uppercase; letter-spacing: 0.7px; margin-bottom: 18px; }
    .d-load-stage { font: 400 11px ui-monospace, monospace; color: var(--pt-text-muted);
      margin-bottom: 14px; min-height: 15px; }
    .d-load-track { height: 9px; background: var(--pt-bg-strip); border: 0.5px solid var(--pt-border);
      border-radius: 5px; overflow: hidden; }
    .d-load-fill { height: 100%; width: 8%; border-radius: 5px;
      background: linear-gradient(90deg, var(--pt-accent-blue), #6fb4ff);
      box-shadow: 0 0 9px rgba(90,140,220,0.55); position: relative;
      transition: width 0.45s cubic-bezier(.4,0,.2,1); }
    .d-load-fill::after { content: ''; position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.28), transparent);
      animation: d-load-shimmer 1.15s linear infinite; }
    @keyframes d-load-shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
    .d-load-pct { font: 600 10px ui-monospace, monospace; color: var(--pt-text-muted);
      letter-spacing: 0.5px; margin-top: 9px; }

    /* Deep-dive modal */
    .dd-backdrop { position: fixed; inset: 0; background: rgba(5,8,12,0.72); backdrop-filter: blur(3px);
      display: flex; align-items: center; justify-content: center; z-index: 9000; }
    .sh-split { display: flex; flex-direction: column; gap: 6px; }
    .sh-top { }
    .sh-tablewrap { max-height: 240px; overflow-y: auto; border: 1px solid rgba(70,90,120,0.25); border-radius: 6px; }
    .sh-bottom { margin-top: 8px; }
    .sh-chart { width: 100%; height: auto; display: block; }
    .sh-line { fill: none; stroke: #7BB0F5; stroke-width: 1.6; }
    .sh-area { fill: rgba(123,176,245,0.12); stroke: none; }
    .sh-dot { fill: #7BB0F5; }
    .sh-grid { stroke: rgba(70,90,120,0.25); stroke-width: 1; }
    .sh-axis { fill: var(--pt-text-muted, #97A0B0); font: 9px ui-monospace, monospace; }
    .sh-cur { fill: #7BB0F5; font: 600 10px ui-monospace, monospace; }
    .sh-src { font: 11px ui-monospace, monospace; color: var(--pt-text-secondary, #C4CCD8); margin-bottom: 10px; }
    .sh-subhead { font: 600 11px ui-monospace, monospace; color: var(--pt-accent-blue-bright, #7BB0F5); text-transform: uppercase; letter-spacing: 0.5px; margin: 14px 0 6px; }
    .sh-dim { color: var(--pt-text-muted, #97A0B0); font-weight: 400; text-transform: none; letter-spacing: 0; }
    .sh-table { width: 100%; border-collapse: collapse; font: 11px ui-monospace, monospace; }
    .sh-table th { text-align: left; color: var(--pt-text-muted, #97A0B0); font-weight: 600; text-transform: uppercase; font-size: 9px; letter-spacing: 0.5px; padding: 4px 8px; border-bottom: 1px solid var(--pt-border, #2b3440); position: sticky; top: 0; background: var(--pt-bg, #0d1117); }
    .sh-table td { padding: 3px 8px; border-bottom: 1px solid rgba(70,90,120,0.18); color: var(--pt-text-primary, #F2F5F9); }
    .sh-table .sh-ep { color: var(--pt-text-secondary, #C4CCD8); }
    .sh-table .sh-bal { text-align: right; }
    .sh-table .sh-delta { text-align: right; }
    .sh-up { color: #46c46a; }
    .sh-dn { color: #e8615d; }
    .sh-d0 { color: var(--pt-text-muted, #97A0B0); }
    .sh-tx { color: var(--pt-accent-blue, #4a9eff); cursor: help; }
    .dd-modal { background: var(--pt-bg, #0d1117); border: 1px solid var(--pt-border, #2b3440); border-radius: 10px;
      width: min(880px, 94vw); max-height: 88vh; overflow: auto; box-shadow: 0 24px 60px rgba(0,0,0,0.6); }
    .dd-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
      padding: 16px 20px; border-bottom: 1px solid var(--pt-border); position: sticky; top: 0; background: var(--pt-bg, #0d1117); }
    .dd-title { font: 600 14px ui-monospace, monospace; color: var(--pt-text-primary); }
    .dd-title .addr { display: block; font: 400 11px ui-monospace, monospace; color: var(--pt-text-muted); margin-top: 3px; word-break: break-all; }
    .dd-close { cursor: pointer; background: #16202e; color: #e8f0f8; border: 1px solid rgba(120,150,190,0.5);
      border-radius: 6px; padding: 5px 11px; font: 600 12px ui-monospace, monospace; flex: 0 0 auto; }
    .dd-body { padding: 18px 20px 24px; }
    .dd-loading { padding: 48px; text-align: center; color: var(--pt-text-muted); font: 400 12px ui-monospace, monospace; }
    .dd-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 22px; }
    .dd-stat { background: var(--pt-bg-strip); border: 0.5px solid var(--pt-border); border-radius: 7px; padding: 10px 12px; }
    .dd-stat .l { font: 500 9px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.5px; color: var(--pt-text-muted); }
    .dd-stat .v { font: 600 17px ui-monospace, monospace; color: var(--pt-text-primary); margin-top: 4px; }
    .dd-stat .v .u { font-size: 11px; color: var(--pt-text-muted); margin-left: 2px; }
    .dd-section-title { font: 600 11px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.6px;
      color: var(--pt-accent-blue); margin: 0 0 14px; }
    .dd-drep { display: inline-block; font: 600 9px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.4px;
      background: rgba(120,90,220,0.18); color: #b39dff; border: 0.5px solid rgba(150,120,240,0.5); padding: 1px 6px; border-radius: 3px; margin-left: 8px; }

    /* Journey timeline */
    .dd-journey { display: flex; align-items: stretch; gap: 0; overflow-x: auto; padding: 10px 10px 18px; }
    .dd-hop { display: flex; align-items: center; flex: 0 0 auto; }
    .dd-node { width: 132px; border-radius: 9px; padding: 12px 12px 11px; color: #fff; position: relative;
      box-shadow: 0 4px 14px rgba(0,0,0,0.35); }
    .dd-node .tkr { font: 700 14px ui-monospace, monospace; letter-spacing: 0.3px; }
    .dd-node .nm { font: 400 10px ui-monospace, monospace; opacity: 0.85; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dd-node .amt { font: 600 11px ui-monospace, monospace; margin-top: 8px; }
    .dd-node .amt .amt-lbl { display: block; font: 400 8px ui-monospace, monospace; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.4px; margin-top: 1px; }
    .dd-node .ep { font: 400 9px ui-monospace, monospace; opacity: 0.8; margin-top: 2px; }
    .dd-node .dd-flow { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin-top: 7px;
      padding-top: 6px; border-top: 0.5px solid rgba(255,255,255,0.18); }
    .dd-node .dd-flow:first-of-type { border-top: none; padding-top: 0; }
    .dd-node .dd-flow-l { font: 400 8px ui-monospace, monospace; opacity: 0.75; text-transform: uppercase; letter-spacing: 0.4px; }
    .dd-node .dd-flow-v { font: 600 11px ui-monospace, monospace; }
    .dd-node .dd-flow.dd-here .dd-flow-l { color: #ffe9a8; opacity: 0.95; }
    .dd-node.dest { outline: 2px solid var(--pt-accent-gold, #d6b246); outline-offset: 2px; }
    .dd-node .you { position: absolute; top: -9px; right: -8px; background: var(--pt-accent-gold, #d6b246); color: #1a1205;
      font: 700 8px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.4px; padding: 2px 6px; border-radius: 4px; }
    .dd-arrow { flex: 0 0 auto; width: 46px; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--pt-text-muted); gap: 3px; }
    .dd-arrow .ln { font: 700 16px ui-monospace, monospace; color: var(--pt-text-secondary); }
    .dd-arrow .at { font: 400 9px ui-monospace, monospace; white-space: nowrap; }
    .dd-origin-note { font: 400 11px ui-monospace, monospace; color: var(--pt-text-secondary); margin-bottom: 16px; }
    .dd-origin-note b { color: var(--pt-accent-gold, #d6b246); }

    /* Loyalty leaderboard */
    .loy-legend { display: flex; gap: 16px; align-items: center; font: 400 10px ui-monospace, monospace; color: var(--pt-text-muted); padding: 2px 10px 8px; }
    .loy-legend-na { display: block; padding: 6px 10px 10px; }
    .loy-legend-na .loy-na { /*loy-na-red*/ display: block; font: 700 11.5px ui-monospace, monospace; color: #ff6b6b; background: rgba(255,80,80,0.08); border: 1px solid rgba(255,90,90,0.40); border-radius: 6px; padding: 8px 11px; line-height: 1.5; }
    .loy-legend .sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
    .loy-sw-ten { background: #4a9eff; }
    .loy-sw-stk { background: #d6b246; }
    .loy-row { display: grid; grid-template-columns: 30px minmax(110px,1fr) 2.2fr 150px; align-items: center; gap: 12px;
      padding: 8px 10px; border-bottom: 0.5px solid var(--pt-border); }
    .loy-row.head { font: 600 9px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--pt-text-muted); border-bottom: 1px solid var(--pt-border); }
    .loy-row:not(.head):hover { background: rgba(90,140,220,0.10); cursor: pointer; }
    .loy-rank { font: 700 12px ui-monospace, monospace; color: var(--pt-text-muted); text-align: right; }
    .loy-rank.top { color: var(--pt-accent-gold, #d6b246); }
    .loy-addr { font: 400 11px ui-monospace, monospace; color: var(--pt-text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .loy-addr .me { color: var(--pt-accent-gold, #d6b246); font-weight: 700; margin-left: 6px; }
    .loy-flag { font: 600 8px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.3px;
      padding: 1px 5px; border-radius: 3px; margin-left: 8px; cursor: help; }
    .loy-flag.flag-defect { background: rgba(220,70,70,0.18); color: #ff8a8a; border: 0.5px solid rgba(220,70,70,0.5); }
    .loy-flag.flag-reduce { background: rgba(210,160,60,0.16); color: #e0b860; border: 0.5px solid rgba(210,160,60,0.45); }
    .loy-refresh-btn { margin-left: auto; background: var(--pt-bg-strip); color: var(--pt-text-secondary);
      border: 0.5px solid var(--pt-border); border-radius: 4px; padding: 3px 10px; font: 400 10px ui-monospace, monospace;
      cursor: pointer; } .loy-refresh-btn:hover { color: var(--pt-text-primary); border-color: var(--pt-accent-blue); }
    .pt-delegators .loy-wrap { max-height: 560px; overflow: auto; }
    .d-sortbtn { background: var(--pt-bg-strip); color: var(--pt-text-secondary); border: 0.5px solid var(--pt-border);
      border-radius: 4px; padding: 4px 11px; font: 600 10px ui-monospace, monospace; cursor: pointer; text-transform: uppercase; letter-spacing: 0.4px; }
    .d-sortbtn:hover { color: var(--pt-text-primary); border-color: var(--pt-accent-blue); }
    .d-sortbtn.active { background: var(--pt-accent-blue); color: #fff; border-color: var(--pt-accent-blue); }
    /* Unified row: rank | addr | BIG bar | loyalty% | tenure | wt | penalties | stake | % */
    .du-row { display: grid; grid-template-columns: 32px 150px 320px 64px 58px 48px 116px 92px 52px 150px; align-items: center; gap: 10px;
      padding: 7px 10px; border-bottom: 0.5px solid var(--pt-border); }
    .du-row.head { font: 700 9px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.6px; color: var(--pt-accent-blue); border-bottom: 1.5px solid var(--pt-border); position: sticky; top: 0; background: var(--pt-bg, #0d1117); z-index: 2; }
    .du-row:not(.head):hover { background: rgba(90,140,220,0.10); cursor: pointer; }
    .du-actions { display: flex; gap: 5px; justify-content: flex-end; }
    .du-actbtn { font: 600 9px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.4px;
      color: var(--pt-accent-blue-bright, #7BB0F5); background: rgba(90,140,220,0.10);
      border: 1px solid rgba(123,176,245,0.45); border-radius: 4px; padding: 3px 7px; cursor: pointer; white-space: nowrap; }
    .du-actbtn:hover { background: rgba(123,176,245,0.22); border-color: rgba(123,176,245,0.8); }
    .du-rank { font: 700 12px ui-monospace, monospace; color: var(--pt-text-secondary); text-align: right; }
    .du-rank.top { color: var(--pt-accent-gold, #d6b246); }
    .du-addr { font: 400 11px ui-monospace, monospace; color: var(--pt-text-primary); display: flex; align-items: center; gap: 4px; min-width: 0; }
    .du-addr-t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .du-addr .me { color: var(--pt-accent-gold, #d6b246); font-weight: 700; margin-left: 6px; }
    .du-copy { flex: 0 0 auto; background: rgba(90,140,220,0.14); border: 1px solid var(--pt-border); border-radius: 4px; color: var(--pt-accent-blue); cursor: pointer; font: 600 9px ui-monospace, monospace; line-height: 1; padding: 3px 5px; letter-spacing: 0.3px; transition: background 0.12s, color 0.12s; }
    .du-copy:hover { background: var(--pt-accent-blue); color: #fff; }
    .du-copy.copied { background: var(--pt-accent-gold, #d6b246); color: #1a1205; border-color: var(--pt-accent-gold, #d6b246); }
    .du-row.hit { animation: duhit 2.4s ease-out 1; }
    @keyframes duhit { 0% { background: rgba(214,178,70,0.55); } 100% { background: transparent; } }
    .d-search { display: flex; align-items: center; gap: 8px; margin: 8px 8px 4px; }
    .d-search input { flex: 1; min-width: 0; background: var(--pt-bg, #0d1117); border: 1px solid var(--pt-border); border-radius: 6px; color: var(--pt-text-primary); font: 400 11px ui-monospace, monospace; padding: 6px 9px; }
    .d-search button { background: #1b2430; color: var(--pt-text-secondary); border: 1px solid var(--pt-border); border-radius: 6px; font-size: 11px; padding: 6px 12px; cursor: pointer; }
    .d-search button:hover { color: var(--pt-text-primary); }
    .d-search .msg { font: 400 11px ui-monospace, monospace; color: var(--pt-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1 1 auto; min-width: 0; }
    .d-search .msg .full { color: var(--pt-accent-blue); cursor: pointer; }
    .du-barwrap { background: var(--pt-bg-strip, #1a2230); border-radius: 4px; height: 18px; overflow: hidden; display: flex; }
    .du-score { font: 700 14px ui-monospace, monospace; color: #fff; text-align: right; }
    .du-num { font: 600 11px ui-monospace, monospace; color: var(--pt-text-primary); text-align: right; }
    .du-num.dim { color: var(--pt-text-secondary); font-weight: 400; }
    .du-pen { font: 600 10px ui-monospace, monospace; text-align: right; white-space: nowrap; }
    .du-pen .ok { color: #4ea36a; } .du-pen .bad { color: #ff8a8a; } .du-pen .warn { color: #e0b860; } .du-pen .dim { color: var(--pt-text-muted); }
    .du-stake { font: 700 11px ui-monospace, monospace; color: var(--pt-text-primary); text-align: right; }
    .du-pct { font: 500 10px ui-monospace, monospace; color: var(--pt-accent-blue); text-align: right; }
    .du-pagebar { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 10px; }
    .du-pagebtn { background: var(--pt-bg-strip); color: var(--pt-accent-blue); border: 0.5px solid var(--pt-border);
      border-radius: 4px; padding: 6px 16px; font: 600 11px ui-monospace, monospace; cursor: pointer; }
    .du-pagebtn:hover:not(:disabled) { background: rgba(90,140,220,0.14); border-color: var(--pt-accent-blue); }
    .du-pagebtn:disabled { opacity: 0.35; cursor: default; }
    .du-pageinfo { font: 600 11px ui-monospace, monospace; color: var(--pt-text-secondary); }
    .loy-more { display: block; width: 100%; margin: 8px 0 2px; padding: 9px; background: var(--pt-bg-strip);
      color: var(--pt-accent-blue); border: 0.5px solid var(--pt-border); border-radius: 4px;
      font: 600 11px ui-monospace, monospace; cursor: pointer; }
    .loy-more:hover { background: rgba(90,140,220,0.12); border-color: var(--pt-accent-blue); }
    /* Segmented loyalty bar: tenure (blue) + stake (gold) sum to the score length */
    .loy-barwrap { background: var(--pt-bg-strip, #1a2230); border-radius: 4px; height: 18px; overflow: hidden; display: flex; }
    .loy-seg { height: 18px; display: block; }
    .loy-seg-ten { background: #4a9eff; }
    .loy-seg-stk { background: #d6b246; }
    .loy-stats { font: 400 10px ui-monospace, monospace; color: var(--pt-text-muted); text-align: right; white-space: nowrap; }
    .loy-stats .score { font: 700 13px ui-monospace, monospace; color: var(--pt-text-primary); }
    .loy-stats .sub { display: block; margin-top: 2px; }
  </style>
  <div class="pt-delegators" id="pt-delegators">
    <div class="pt-hero-row pt-hero-row-6">
      <div class="pt-hero-card"><div class="pt-hero-label">Delegators</div><div class="pt-hero-value" id="d-count">—</div><div class="pt-hero-sub" id="d-count-sub">live</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Live stake</div><div class="pt-hero-value" id="d-stake">—<span class="pt-hero-unit">₳</span></div><div class="pt-hero-sub" id="d-stake-sub">delegated</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Active stake</div><div class="pt-hero-value" id="d-active">—<span class="pt-hero-unit">₳</span></div><div class="pt-hero-sub" id="d-active-sub">set snapshot</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Top delegator</div><div class="pt-hero-value" id="d-top">—<span class="pt-hero-unit">₳</span></div><div class="pt-hero-sub" id="d-top-sub">largest single</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Pledge</div><div class="pt-hero-value" id="d-pledge">—<span class="pt-hero-unit">₳</span></div><div class="pt-hero-sub" id="d-pledge-sub">live vs declared</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Saturation</div><div class="pt-hero-value" id="d-sat">—<span class="pt-hero-unit">%</span></div><div class="pt-hero-sub" id="d-sat-sub">of cap</div></div>
    </div>

    <div class="pt-panel">
      <div class="pt-panel-header">
        <span class="pt-panel-title">Delegators</span>
        <span class="pt-panel-meta v-muted" id="d-meta" style="margin-left:10px;">—</span>
        <div class="d-sort" style="margin-left:auto;display:flex;align-items:center;gap:8px;">
          <button id="sort-loyalty" class="d-sortbtn active" title="Rank by loyalty: tenure × stake-weight × penalties">Sort: Loyalty</button>
          <button id="sort-stake" class="d-sortbtn" title="Rank by current live stake">Sort: Stake</button>
          <button id="loy-refresh" class="loy-refresh-btn" title="Recompute loyalty from the latest epoch data">↻</button>
          <label class="d-filter" style="display:flex;align-items:center;gap:6px;cursor:pointer;font:400 11px ui-monospace,monospace;color:var(--pt-text-secondary);">
            <input type="checkbox" id="d-dust" checked style="cursor:pointer;">
            Hide &lt; 5 ₳
          </label>
        </div>
      </div>
      <div class="loy-legend" id="d-legend">
        <span title="How long they've delegated unbroken, relative to the longest-serving - blue bar segment."><span class="sw loy-sw-ten"></span>tenure</span>
        <span title="Current stake, weighted so dust ≈ 0 and whales saturate - gold bar segment."><span class="sw loy-sw-stk"></span>stake-weight</span>
        <span title="Loyalty = tenure-rank × stake-weight × defection penalty (×0.25 if moved ≥50% to a rival) × reduction penalty (recent big withdrawal, fades ~6mo).">score = tenure × stake-weight × penalties ⓘ</span>
      </div>
      <div class="d-search">
        <input id="d-search-input" type="text" placeholder="Paste a stake address to find and jump to it\u2026" spellcheck="false" autocomplete="off">
        <button id="d-search-go" type="button">Search</button>
        <button id="d-search-clear" type="button">Clear</button>
        <span class="msg" id="d-search-msg"></span>
      </div>
      <div class="pt-tbl-wrap loy-wrap" id="d-table"></div>
    </div>
  </div>`;

const fmtAda = (n) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtAdaFull = (n) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 });
const shortStake = (s) => !s ? '—' : `${s.slice(0, 12)}…${s.slice(-6)}`;

// Copy text to clipboard, with a brief check-mark on the button that fired.
function copyStake(text, btn) {
  const flash = () => { if (!btn) return; const p = btn.innerHTML; btn.innerHTML = '\u2713 copied'; btn.classList.add('copied'); setTimeout(() => { btn.innerHTML = p; btn.classList.remove('copied'); }, 1100); };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(() => fallbackCopy(text, flash));
    } else { fallbackCopy(text, flash); }
  } catch { fallbackCopy(text, flash); }
}
function fallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    done && done();
  } catch (e) { console.warn('[delegators] copy failed:', e); }
}

// Find a stake address in the current (sorted/filtered) view, jump to its page,
// scroll it into view and pulse it. Falls back to a helpful message if the
// address is hidden by the dust filter or genuinely absent.
function jumpToStake(raw) {
  const msg = document.getElementById('d-search-msg');
  const q = (raw || '').trim().toLowerCase();
  if (!q) { if (msg) msg.textContent = ''; return; }
  let i = _duView.findIndex((r) => r.stake && r.stake.toLowerCase() === q);
  if (i < 0) i = _duView.findIndex((r) => r.stake && r.stake.toLowerCase().includes(q));
  if (i < 0) {
    const inAll = _duRows.some((r) => r.stake && r.stake.toLowerCase().includes(q));
    if (msg) msg.textContent = inAll
      ? 'That delegator is hidden by the "Hide < 5 ₳" filter — untick it to see them.'
      : 'No delegator matches that address.';
    return;
  }
  _duPage = Math.floor(i / LOY_MAX_ROWS);
  if (_duDrawPage) _duDrawPage();
  const wrap = document.getElementById('d-table');
  const full = _duView[i].stake;
  const row = wrap && wrap.querySelector('.du-row[data-stake="' + full + '"]');
  if (row) {
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.classList.remove('hit'); void row.offsetWidth; row.classList.add('hit');
  }
  if (msg) msg.innerHTML = 'Found at rank ' + (i + 1) + ': <span class="full" data-copy="' + full + '" title="Click to copy">' + full + '</span>';
}

function setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }

// ---- Deep-dive modal ------------------------------------------------------

function closeDeepDive() {
  const b = document.getElementById('dd-backdrop');
  if (b) b.remove();
}

function ddShell(stake) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="dd-backdrop" id="dd-backdrop">
      <div class="dd-modal">
        <div class="dd-head">
          <div class="dd-title">Delegator detail<span class="addr">${stake}</span></div>
          <button class="dd-close" id="dd-close">Close \u2715</button>
        </div>
        <div class="dd-body" id="dd-body">
          <div class="dd-loading">Fetching delegation history\u2026</div>
        </div>
      </div>
    </div>`;
  const node = wrap.firstElementChild;
  document.body.appendChild(node);
  node.addEventListener('click', (e) => { if (e.target === node) closeDeepDive(); });
  const x = document.getElementById('dd-close');
  if (x) x.addEventListener('click', closeDeepDive);
  return node;
}

function renderJourney(runs) {
  // runs: [{ poolId, entryEpoch, entryStake, exitEpoch, exitStake, isCurrent, ticker, name }]
  // chronological. Each node shows ENTRY (epoch + stake) and EXIT (epoch + stake);
  // the current pool shows "still here" with no exit. Each run's exit epoch equals
  // the next run's entry epoch, so the chain is self-verifying.
  if (!runs || !runs.length) return '<div class="v-muted">No delegation history available.</div>';
  const fmt = (n) => n == null ? '\u2014' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const lastIdx = runs.length - 1;
  const hops = runs.map((r, i) => {
    const isUs = r.poolId === OUR_POOL;
    const col = poolColor(r.poolId, isUs);
    const tkr = r.ticker || (r.poolId ? r.poolId.slice(0, 9) + '\u2026' : '?');
    const nm = r.name || '';
    const entry = `<div class="dd-flow"><span class="dd-flow-l">in \u00b7 ep ${r.entryEpoch ?? '?'}</span><span class="dd-flow-v">${fmt(r.entryStake)} \u20b3</span></div>`;
    const exit = r.isCurrent
      ? `<div class="dd-flow dd-here"><span class="dd-flow-l">still here</span><span class="dd-flow-v">${fmt(r.exitStake)} \u20b3 now</span></div>`
      : `<div class="dd-flow"><span class="dd-flow-l">out \u00b7 ep ${r.exitEpoch ?? '?'}</span><span class="dd-flow-v">${fmt(r.exitStake)} \u20b3</span></div>`;
    const node = `
      <div class="dd-node${isUs ? ' dest' : ''}" style="background:${col}">
        ${isUs ? '<span class="you">your pool</span>' : ''}
        <div class="tkr">${tkr}</div>
        <div class="nm">${nm}</div>
        ${entry}
        ${exit}
      </div>`;
    const arrow = i < lastIdx
      ? `<div class="dd-arrow"><span class="ln">\u2192</span><span class="at">ep ${runs[i + 1].entryEpoch ?? '?'}</span></div>`
      : '';
    return `<div class="dd-hop">${node}${arrow}</div>`;
  }).join('');
  return `<div class="dd-journey">${hops}</div>`;
}

function closeStakeHistory() {
  const b = document.getElementById('sh-backdrop');
  if (b) b.remove();
}

function shShell(stake) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="dd-backdrop" id="sh-backdrop">
      <div class="dd-modal">
        <div class="dd-head">
          <div class="dd-title">Stake history<span class="addr">${stake}</span></div>
          <button class="dd-close" id="sh-close">Close \u2715</button>
        </div>
        <div class="dd-body" id="sh-body">
          <div class="dd-loading">Fetching stake history\u2026</div>
        </div>
      </div>
    </div>`;
  const node = wrap.firstElementChild;
  document.body.appendChild(node);
  node.addEventListener('click', (e) => { if (e.target === node) closeStakeHistory(); });
  document.getElementById('sh-close')?.addEventListener('click', closeStakeHistory);
  return node;
}

const _shAda = (n) => (n == null ? '\u2014' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
function _shDelta(n) {
  if (n == null) return '<span class="sh-d0">\u2014</span>';
  if (n > 0) return `<span class="sh-up">+${_shAda(n)}</span>`;
  if (n < 0) return `<span class="sh-dn">${_shAda(n)}</span>`;
  return '<span class="sh-d0">0</span>';
}

async function openStakeHistory(stake) {
  shShell(stake);
  let data = null;
  try {
    data = await registry.get(DataKind.DELEGATOR_STAKE_HISTORY, { stake, currentEpoch: _currentEpoch });
  } catch (e) {
    console.warn('[stakehist] fetch failed:', e.message ?? e);
  }
  const body = document.getElementById('sh-body');
  if (!body) return;   // closed while loading
  if (!data || !Array.isArray(data.epochs) || !data.epochs.length) {
    body.innerHTML = '<div class="dd-loading">No stake history available for this delegator from the current source.</div>';
    return;
  }

  const src = data.source || '\u2014';
  const grain = data.granularity === 'epoch+intra'
    ? 'per-epoch + intra-epoch'
    : 'per-epoch (epoch-grained)';
  const note = (data.granularity === 'epoch')
    ? ' \u00b7 enable db-sync for intra-epoch tx detail'
    : '';

  // Per-epoch table, newest first.
  const epochs = data.epochs.slice().reverse();
  const rowsHtml = epochs.map((e) => `
    <tr>
      <td class="sh-ep">${e.epoch}</td>
      <td class="sh-bal">${_shAda(e.runningBalance)} \u20b3</td>
      <td class="sh-delta">${_shDelta(e.delta)}</td>
    </tr>`).join('');

  // Intra-epoch events (db-sync only), newest first.
  let eventsHtml = '';
  if (Array.isArray(data.events) && data.events.length) {
    const evs = data.events.slice().reverse();
    const evRows = evs.map((v) => {
      const label = v.kind === 'reward' ? 'reward in'
        : v.kind === 'withdrawal' ? 'withdrawal out'
        : v.kind;
      const amt = v.amount == null ? '\u2014'
        : (v.amount > 0 ? `<span class="sh-up">+${_shAda(v.amount)}</span>`
                        : `<span class="sh-dn">${_shAda(v.amount)}</span>`);
      const tx = v.txHash ? `<span class="sh-tx" title="${v.txHash}">${v.txHash.slice(0, 12)}\u2026</span>` : '\u2014';
      return `<tr><td class="sh-ep">${v.epoch ?? '\u2014'}</td><td>${label}</td><td class="sh-delta">${amt} \u20b3</td><td>${tx}</td></tr>`;
    }).join('');
    eventsHtml = `
      <div class="sh-subhead">Intra-epoch movements <span class="sh-dim">(rewards &amp; withdrawals, exact from db-sync)</span></div>
      <table class="sh-table">
        <thead><tr><th>epoch</th><th>type</th><th class="sh-delta">amount</th><th>tx</th></tr></thead>
        <tbody>${evRows}</tbody>
      </table>`;
  }

  const chart = _shSparkline(data.epochs);

  body.innerHTML = `
    <div class="sh-src">Source: <strong>${src}</strong> \u00b7 ${grain}${note}</div>
    <div class="sh-split">
      <div class="sh-top">
        <div class="sh-subhead">Active stake by epoch <span class="sh-dim">(newest first)</span></div>
        <div class="sh-tablewrap">
          <table class="sh-table">
            <thead><tr><th>epoch</th><th class="sh-bal">balance</th><th class="sh-delta">change</th></tr></thead><!--/*sh-align*/-->
            <tbody>${rowsHtml}</tbody>
          </table>
          ${eventsHtml}
        </div>
      </div>
      <div class="sh-bottom">
        <div class="sh-subhead">Running balance <span class="sh-dim">(all ${data.epochs.length} epochs, oldest \u2192 newest)</span></div>
        ${chart}
      </div>
    </div>`;
}

/* Inline SVG line chart of running balance across all epochs. No chart library:
 * builds a polyline + area fill scaled to the data, with min/current/max labels. */
function _shSparkline(epochs) {
  const pts = (epochs || []).filter((e) => e && e.runningBalance != null);
  if (pts.length < 2) return '<div class="sh-dim" style="padding:8px">Not enough data to chart.</div>';

  const W = 560, H = 200, PADL = 64, PADR = 14, PADT = 12, PADB = 26;
  const iw = W - PADL - PADR, ih = H - PADT - PADB;

  const xs = pts.map((p) => p.epoch);
  const ys = pts.map((p) => p.runningBalance);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  let yMin = Math.min(...ys), yMax = Math.max(...ys);
  if (yMin === yMax) { yMin -= 1; yMax += 1; }                 // flat line guard
  const pad = (yMax - yMin) * 0.08; yMin -= pad; yMax += pad;  // breathing room

  const sx = (x) => PADL + ((x - xMin) / (xMax - xMin || 1)) * iw;
  const sy = (y) => PADT + (1 - (y - yMin) / (yMax - yMin || 1)) * ih;

  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.epoch).toFixed(1)},${sy(p.runningBalance).toFixed(1)}`).join(' ');
  const area = `${line} L${sx(xMax).toFixed(1)},${(PADT + ih).toFixed(1)} L${sx(xMin).toFixed(1)},${(PADT + ih).toFixed(1)} Z`;

  const fmt = (n) => Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const cur = ys[ys.length - 1];
  const yTicks = [yMax, (yMax + yMin) / 2, yMin].map((v) => {
    const yy = sy(v).toFixed(1);
    return `<line x1="${PADL}" y1="${yy}" x2="${W - PADR}" y2="${yy}" class="sh-grid"/>` +
           `<text x="${PADL - 6}" y="${(Number(yy) + 3).toFixed(1)}" class="sh-axis" text-anchor="end">${fmt(v)}</text>`;
  }).join('');
  const xTicks = [xMin, Math.round((xMin + xMax) / 2), xMax].map((v) => {
    const xx = sx(v).toFixed(1);
    return `<text x="${xx}" y="${H - 8}" class="sh-axis" text-anchor="middle">ep ${v}</text>`;
  }).join('');

  const lastX = sx(xMax).toFixed(1), lastY = sy(cur).toFixed(1);

  return `<svg class="sh-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Running balance chart">
    ${yTicks}${xTicks}
    <path d="${area}" class="sh-area"/>
    <path d="${line}" class="sh-line"/>
    <circle cx="${lastX}" cy="${lastY}" r="3.2" class="sh-dot"/>
    <text x="${Number(lastX) - 6}" y="${Number(lastY) - 8}" class="sh-cur" text-anchor="end">${fmt(cur)} \u20b3</text>
  </svg>`;
}

async function openDeepDive(stake) {
  ddShell(stake);
  let detail = null;
  try {
    detail = await registry.get(DataKind.DELEGATOR_DETAIL, { stake, currentEpoch: _currentEpoch });
  } catch (e) {
    console.warn('[delegators] detail failed:', e.message ?? e);
  }
  const body = document.getElementById('dd-body');
  if (!body) return;   // modal closed while loading
  if (!detail) { body.innerHTML = '<div class="dd-loading">Could not load delegator detail. (The deep-dive needs Blockfrost \u2014 add a project key in setup.)</div>'; return; }

  // Resolve pool tickers/names for each run (cached; usually 1\u20133 distinct pools).
  const runs = Array.isArray(detail.runs) ? detail.runs.slice() : [];
  await Promise.all(runs.map(async (r) => {
    if (!r.poolId) return;
    try { const m = await blockfrost.getPoolMeta(r.poolId); if (m) { r.ticker = m.ticker; r.name = m.name; } } catch { /* ignore */ }
  }));

  // Origin note (the pool they switched from to join us).
  let originHtml = '';
  if (detail.cameFrom) {
    let label = detail.cameFrom.slice(0, 12) + '\u2026';
    try { const m = await blockfrost.getPoolMeta(detail.cameFrom); if (m && m.ticker) label = m.ticker; } catch { /* ignore */ }
    originHtml = `<div class="dd-origin-note">Joined your pool from <b>${label}</b>.</div>`;
  } else {
    originHtml = `<div class="dd-origin-note">Your pool appears to be their first (or earliest tracked) delegation.</div>`;
  }

  const drep = detail.drepId ? `<span class="dd-drep">DRep</span>` : '';
  const fmt = (n) => n == null ? '\u2014' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

  body.innerHTML = `
    <div class="dd-stats">
      <div class="dd-stat"><div class="l">Balance</div><div class="v">${fmt(detail.balance)}<span class="u">\u20b3</span></div></div>
      <div class="dd-stat"><div class="l">Rewards earned</div><div class="v">${fmt(detail.rewardsSum)}<span class="u">\u20b3</span></div></div>
      <div class="dd-stat"><div class="l">Withdrawn</div><div class="v">${fmt(detail.withdrawalsSum)}<span class="u">\u20b3</span></div></div>
      <div class="dd-stat"><div class="l">Since epoch</div><div class="v">${detail.sinceEpoch ?? '\u2014'}${drep}</div></div>
    </div>
    <div class="dd-section-title">Pool movement</div>
    ${originHtml}
    ${renderJourney(runs)}
  `;
}


// ---- Loyalty leaderboard --------------------------------------------------

// Approx human duration for an epoch count (Cardano epoch = 5 days).
function tenureLabel(epochs) {
  const days = epochs * 5;
  if (days < 60) return `${days}d`;
  const months = days / 30.44;
  if (months < 24) return `${months.toFixed(months < 10 ? 1 : 0)}mo`;
  return `${(months / 12).toFixed(1)}yr`;
}
const fmtStakeShort = (ada) => {
  if (ada == null) return '—';
  if (ada >= 1_000_000) return `${(ada / 1_000_000).toFixed(1)}M`;
  if (ada >= 1_000) return `${Math.round(ada / 1_000)}k`;
  return String(ada);
};

// Loyalty weighting (tunable). Score = tenureScore(0-100) × stakeWeight(0-1),
// where stakeWeight = avg_stake / (avg_stake + K) sends dust → ~0 while
// saturating for whales. K = half-weight stake. The segmented bar splits the
// score into a tenure share and a stake share so you can see what drives it.
const LOY_K = 10000;          // ADA half-weight point
const LOY_DUST_FLOOR = 5;     // avg stake below this = excluded when dust filter on
const LOY_MAX_ROWS = 100;     // leaderboard renders top-N (full set still ranked/cached)

// ---- Loyalty data (cache-first; computed once per epoch) ------------------

async function fetchLoyaltyData(forceRecompute) {
  if (!registry.can(DataKind.DELEGATOR_LOYALTY)) return null; // no db-sync
  let rows = [];
  const curEpoch = _currentEpoch || 0;
  let cachedEpoch = null;
  try { cachedEpoch = await readModel.cacheLoyaltyEpoch(); } catch { /* ignore */ }
  const cacheFresh = cachedEpoch != null && curEpoch > 0 && Number(cachedEpoch) >= curEpoch;

  if (cacheFresh && !forceRecompute) {
    try { rows = await readModel.cacheGetLoyalty() || []; } catch { rows = []; }
  }
  if (!rows.length) {
    setText('d-meta', forceRecompute ? 'recomputing loyalty…' : 'building loyalty data…');
    const t0 = Date.now();
    try {
      rows = await registry.get(DataKind.DELEGATOR_LOYALTY) || [];
      console.log(`[loyalty] computed ${rows.length} rows in ${Date.now() - t0}ms`);
    } catch (e) {
      console.warn('[loyalty] compute failed:', e.message ?? e);
      return null;
    }
    if (rows.length && curEpoch > 0) {
      readModel.cachePutLoyalty(curEpoch, rows.map((r) => ({
        stake: r.stake, tenure: r.tenure, sinceEpoch: r.sinceEpoch, curStake: r.curStake,
        reductionFactor: r.reductionFactor || 0, defected: !!r.defected,
        defectToPool: r.defectToPool || null, defectEpoch: r.defectEpoch ?? null,
        defectToAda: r.defectToAda ?? null,
      }))).catch(() => {});
    }
  }
  return rows;
}

// Score loyalty rows → map keyed by stake address with all sub-scores.
function scoreLoyalty(rows) {
  const maxTenure = rows.reduce((m, r) => Math.max(m, r.tenure), 1);
  const map = new Map();
  for (const r of rows) {
    const tScore = (r.tenure / maxTenure) * 100;              // 0..100
    const stakeWeight = r.curStake / (r.curStake + LOY_K);     // 0..1
    const defectionPenalty = r.defected ? 0.25 : 1;
    const reductionPenalty = 1 - (Math.min(1, r.reductionFactor || 0) * 0.5);
    const loyalty = tScore * stakeWeight * defectionPenalty * reductionPenalty;
    const a = r.tenure / maxTenure, b = stakeWeight, denom = (a + b) || 1;
    map.set(r.stake, {
      ...r, tScore, stakeWeight, defectionPenalty, reductionPenalty, loyalty,
      tenSeg: loyalty * (a / denom), stkSeg: loyalty * (b / denom),
    });
  }
  return { map, maxTenure };
}

// ---- Unified table render -------------------------------------------------

function unifiedRowHtml(r, idx, totalStakeLov, ownerSet) {
  const isMe = ownerSet.has(r.stake);
  const pct = totalStakeLov ? ((r.liveStakeLovelace || 0) / totalStakeLov * 100) : 0;
  const hasLoy = r.loyalty != null;
  const tenW = hasLoy ? r.tenSeg.toFixed(1) : 0;
  const stkW = hasLoy ? r.stkSeg.toFixed(1) : 0;
  const stakeWeightPct = hasLoy ? Math.round(r.stakeWeight * 100) : 0;

  // Penalties cell — explicit, colour-coded.
  let penCell = '<span class="ok">none</span>';
  if (hasLoy && r.defected) {
    penCell = `<span class="bad" title="Moved \u226550% of stake to another pool (${shortStake(r.defectToPool)}) ~epoch ${r.defectEpoch}. Loyalty \u00d70.25.">defected \u00d70.25</span>`;
  } else if (hasLoy && r.reductionPenalty < 0.999) {
    const dockPct = Math.round((1 - r.reductionPenalty) * 100);
    penCell = `<span class="warn" title="Large withdrawal to wallet (not a rival pool). Loyalty docked ${dockPct}%, fading ~6mo.">\u2212${dockPct}% withdraw</span>`;
  } else if (!hasLoy) {
    penCell = '<span class="dim">\u2014</span>';
  }

  const tipTen = hasLoy ? `Tenure ${r.tenure} epochs (~${tenureLabel(r.tenure)}) unbroken, since epoch ${r.sinceEpoch}. Blue = tenure share of the bar.` : '';
  const tipStk = hasLoy ? `Current stake ${Number(r.curStake).toLocaleString()} \u20b3 \u2192 stake-weight ${stakeWeightPct}% (dust\u22480, whales saturate). Gold = stake share.` : '';
  const tipScore = hasLoy ? `Loyalty ${r.loyalty.toFixed(1)}/100 = tenure-rank(${r.tScore.toFixed(0)}) \u00d7 stake-weight(${(r.stakeWeight).toFixed(2)})${r.defected ? ' \u00d7 0.25' : ''}${r.reductionPenalty < 0.999 ? ` \u00d7 ${r.reductionPenalty.toFixed(2)}` : ''}.` : 'No loyalty data';

  const bar = hasLoy
    ? `<span class="du-barwrap" title="Loyalty ${r.loyalty.toFixed(0)}/100 \u2014 blue tenure, gold stake.">
         <span class="loy-seg loy-seg-ten" style="width:${tenW}%" title="${tipTen}"></span>
         <span class="loy-seg loy-seg-stk" style="width:${stkW}%" title="${tipStk}"></span>
       </span>`
    : `<span class="du-barwrap"></span>`;

  let mark = '';
  if (isMe) mark = '<span class="me">you</span>';
  return `<div class="du-row" data-stake="${r.stake}">
    <span class="du-rank${idx < 3 ? ' top' : ''}">${idx + 1}</span>
    <span class="du-addr" title="${r.stake}\nClick for full stake history"><span class="du-addr-t">${shortStake(r.stake)}${mark}</span><button class="du-copy" type="button" data-copy="${r.stake}" title="Copy full stake address">\u29C9 copy</button></span>
    ${bar}
    <span class="du-score" title="${tipScore}">${hasLoy ? r.loyalty.toFixed(0) : '\u2014'}</span>
    <span class="du-num" title="${tipTen}">${hasLoy ? tenureLabel(r.tenure) : '\u2014'}</span>
    <span class="du-num dim" title="${tipStk}">${hasLoy ? stakeWeightPct + '%' : '\u2014'}</span>
    <span class="du-pen">${penCell}</span>
    <span class="du-stake" title="Current live stake">${fmtStakeShort(r.liveStake)} \u20b3</span>
    <span class="du-pct">${pct.toFixed(2)}%</span>
    <span class="du-actions"><button class="du-actbtn du-deleg" type="button" data-stake="${r.stake}" title="Delegation history (pool movements)">Deleg</button><button class="du-actbtn du-stakehist" type="button" data-stake="${r.stake}" title="Stake history (per-epoch balance)">Stake</button></span>
  </div>`;
}

// State for the unified table.
let _duRows = [];        // merged + scored rows (full set)
let _duSort = 'loyalty'; // 'loyalty' | 'stake'
let _duOwners = new Set();
let _duTotalStake = 0;
let _duPage = 0;         // current page (paginated, replace-style)
let _duView = [];        // last-rendered sorted/filtered view (for search-jump)
let _duDrawPage = null;  // active drawPage() closure (jump-to-page)
let _duListCache = null; // last fetched delegator list (instant re-nav cache)
let _duLiveCache = null; // last fetched POOL_LIVE hero stats
let _duCacheTs = 0;      // when the cache above was fetched
const DU_CACHE_TTL = 120000; // reuse the cached list for 2 minutes

function renderUnified() {
  stopLoadCreep();
  const wrap = document.getElementById('d-table');
  if (!wrap) return;
  const dustOn = !!document.getElementById('d-dust')?.checked;
  let view = _duRows.filter((r) => !dustOn || (r.liveStake || 0) >= LOY_DUST_FLOOR);
  if (_duSort === 'stake') view.sort((a, b) => (b.liveStakeLovelace || 0) - (a.liveStakeLovelace || 0));
  else view.sort((a, b) => (b.loyalty ?? -1) - (a.loyalty ?? -1));

  _duView = view;
  const hidden = _duRows.length - view.length;
  const who = registry.describe(DataKind.DELEGATOR_LIST);
  setText('d-meta', `${view.length} shown${hidden ? ` \u00b7 ${hidden} dust hidden` : ''} \u00b7 sorted by ${_duSort} \u00b7 source: ${who?.name ?? '\u2014'}`);

  const head = `<div class="du-row head">
    <span class="du-rank">#</span><span>Stake address</span>
    <span>Loyalty&nbsp;&nbsp;<span style="color:#4a9eff">tenure</span> + <span style="color:#d6b246">stake</span></span>
    <span class="du-score">Loyalty (%)</span>
    <span class="du-num">tenure</span>
    <span class="du-num">wt</span>
    <span class="du-pen">penalties</span>
    <span class="du-stake">live stake</span>
    <span class="du-pct">% pool</span>
    <span class="du-actions">history</span>
  </div>`;

  const PER = LOY_MAX_ROWS;
  const pages = Math.max(1, Math.ceil(view.length / PER));
  if (_duPage >= pages) _duPage = 0;

  const drawPage = () => {
    const start = _duPage * PER;
    const slice = view.slice(start, start + PER);
    const body = slice.map((r, k) => unifiedRowHtml(r, start + k, _duTotalStake, _duOwners)).join('');
    wrap.innerHTML = head + body;
    wrap.querySelectorAll('.du-deleg[data-stake]').forEach((b) => {
      b.addEventListener('click', (e) => { e.stopPropagation(); openDeepDive(b.getAttribute('data-stake')); });
    });
    wrap.querySelectorAll('.du-stakehist[data-stake]').forEach((b) => {
      b.addEventListener('click', (e) => { e.stopPropagation(); openStakeHistory(b.getAttribute('data-stake')); });
    });
    wrap.querySelectorAll('.du-copy[data-copy]').forEach((b) => {
      b.addEventListener('click', (e) => { e.stopPropagation(); copyStake(b.getAttribute('data-copy'), b); });
    });
    // WebKitGTK lays out %-width flex children at 0 on first paint; re-apply
    // the width after layout to force a correct reflow so bars show first time. /*barfix*/
    requestAnimationFrame(() => {
      wrap.querySelectorAll('.loy-seg').forEach((seg) => {
        const w = seg.style.width; if (!w) return;
        seg.style.width = '0'; void seg.offsetWidth; seg.style.width = w;
      });
    });
    wrap.scrollTop = 0;
    // page bar
    const panel = wrap.closest('.pt-panel') || wrap.parentElement;
    let bar = panel.querySelector('.du-pagebar');
    if (bar) bar.remove();
    if (pages > 1) {
      bar = document.createElement('div');
      bar.className = 'du-pagebar';
      const from = start + 1, to = Math.min(start + PER, view.length);
      bar.innerHTML = `<button class="du-pagebtn" id="du-prev"${_duPage === 0 ? ' disabled' : ''}>\u2190 Prev</button>
        <span class="du-pageinfo">${from}\u2013${to} of ${view.length} \u00b7 page ${_duPage + 1}/${pages}</span>
        <button class="du-pagebtn" id="du-next"${_duPage >= pages - 1 ? ' disabled' : ''}>Next \u2192</button>`;
      panel.appendChild(bar);
      bar.querySelector('#du-prev')?.addEventListener('click', () => { if (_duPage > 0) { _duPage--; drawPage(); } });
      bar.querySelector('#du-next')?.addEventListener('click', () => { if (_duPage < pages - 1) { _duPage++; drawPage(); } });
    }
  };
  _duDrawPage = drawPage;
  drawPage();
}


function renderEmpty(root) {
  root.innerHTML = `
    <div class="pt-empty">
      <h3>Delegator analytics needs a data source</h3>
      <p>This view shows who delegates to your pool — individual stake, top delegators,
         your pledge, and (with movement history) where each delegator came from.</p>
      <p>It is powered by an <strong>optional</strong> source. To enable it, add a free
         <strong>Blockfrost</strong> project key in setup, or run <strong>db-sync</strong>.
         The rest of PoolTerminal works without it.</p>
      <p class="v-muted">Once a source is connected, this view fills automatically.</p>
    </div>`;
}

function renderTable(el, list, totalStake) {
  const rows = list.map((d, i) => {
    const pct = totalStake ? (d.liveStakeLovelace / totalStake) * 100 : 0;
    const barW = Math.max(2, Math.round(pct * 1.6));   // visual scale
    const badge = d.isOwner ? '<span class="badge badge-pledge">pledge</span>' : '';
    return `<tr data-stake="${d.stake}" title="Click to view full stake history">
      <td class="left">${i + 1}</td>
      <td class="left addr">${shortStake(d.stake)}${badge}<span class="click-hint">Click to view full stake history →</span></td>
      <td>${fmtAda(d.liveStake)}</td>
      <td>${pct.toFixed(2)}%</td>
      <td class="left"><span class="bar" style="width:${barW}px"></span></td>
    </tr>`;
  }).join('');
  el.innerHTML = `
    <table>
      <thead><tr>
        <th>#</th><th class="left">Stake address</th><th>Live stake ₳</th><th>% of pool</th><th class="left">&nbsp;</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  // Row click → deep-dive modal
  el.querySelectorAll('tr[data-stake]').forEach((tr) => {
    tr.addEventListener('click', () => openDeepDive(tr.getAttribute('data-stake')));
  });
}

// ---- Loading overlay + staged progress -------------------------------------
// Rendered into #d-table; the table render replaces it when data is ready.
// The bar CREEPS from each checkpoint toward the next during every await, so it
// never sits frozen — important on the first visit, where Blockfrost init can
// take several seconds before any data arrives.
let _loadTimer = null;
let _loadCeil = 30;
let _loadCur = 8;
function _loadPaint(p) {
  const v = Math.max(0, Math.min(100, p));
  const fill = document.getElementById('d-load-fill');
  const pc = document.getElementById('d-load-pct');
  if (fill) fill.style.width = v + '%';
  if (pc) pc.textContent = Math.round(v) + '%';
}
function stopLoadCreep() { if (_loadTimer) { clearInterval(_loadTimer); _loadTimer = null; } }
function _startLoadCreep() {
  stopLoadCreep();
  _loadTimer = setInterval(() => {
    const target = _loadCeil - 1;
    if (_loadCur < target) { _loadCur += Math.max(0.25, (target - _loadCur) * 0.05); _loadPaint(_loadCur); }
  }, 200);
}
function showDelegLoading() {
  const wrap = document.getElementById('d-table');
  if (!wrap) return;
  wrap.innerHTML =
    '<div class="d-load">' +
      '<div class="d-load-title">Loading delegators</div>' +
      '<div class="d-load-stage" id="d-load-stage">Connecting to sources\u2026</div>' +
      '<div class="d-load-track"><div class="d-load-fill" id="d-load-fill"></div></div>' +
      '<div class="d-load-pct" id="d-load-pct">8%</div>' +
    '</div>';
  _loadCur = 8; _loadCeil = 30;
  _loadPaint(_loadCur);
  _startLoadCreep();
}
// setLoadProgress(floor, stage, ceil): jump to `floor`, set the stage label, and
// let the bar creep toward `ceil` while the next await runs.
function setLoadProgress(floor, stage, ceil) {
  if (floor != null && floor > _loadCur) _loadCur = floor;   // forward only
  if (ceil != null) _loadCeil = ceil;
  const st = document.getElementById('d-load-stage');
  if (st && stage != null) st.textContent = stage;
  _loadPaint(_loadCur);
  if (!_loadTimer) _startLoadCreep();
}

export async function mountDelegators(canvas) {
  canvas.innerHTML = DELEGATORS_HTML;
  const root = canvas.querySelector('#pt-delegators');
  // Instant re-nav: reuse a recently fetched delegator list from memory rather
  // than re-querying the source (Koios pool_delegators can take ~20s). /*du-cache*/
  const _cacheFresh = _duListCache && (Date.now() - _duCacheTs) < DU_CACHE_TTL;
  if (!_cacheFresh) {
    showDelegLoading();   // spinner only on a real fetch
    // Optional Blockfrost enrichment — idempotent, no-op without a key.
    try { await readModel.ensureBlockfrost(); } catch { /* ignore */ }
  }

  // Need a delegator-list source (db-sync or Blockfrost). POOL_LIVE (hero live
  // stats) is a bonus — if absent (e.g. db-sync only, no Blockfrost key), the
  // list still works and the hero stats fall back gracefully.
  if (!registry.can(DataKind.DELEGATOR_LIST)) {
    renderEmpty(root);
    return;
  }

  setText('d-meta', 'loading…');
  let live = null, list = [];
  if (_cacheFresh) { list = _duListCache; live = _duLiveCache; }
  else try {
    if (registry.can(DataKind.POOL_LIVE)) {
      setLoadProgress(34, 'Loading live pool stats\u2026', 44);
      try { live = await registry.get(DataKind.POOL_LIVE); } catch { live = null; }
    }
    setLoadProgress(46, 'Fetching delegators\u2026', 86);
    list = await registry.get(DataKind.DELEGATOR_LIST);
    setLoadProgress(88, 'Loading history\u2026', 92);
  } catch (e) {
    console.warn('[delegators] load failed:', e.message ?? e);
    renderEmpty(root);
    return;
  }
  if (!Array.isArray(list)) list = [];
  if (!_cacheFresh) { _duListCache = list; _duLiveCache = live; _duCacheTs = Date.now(); }

  // Hero stats (computed on the FULL list — totals are always whole-pool).
  const totalStakeLov = list.reduce((s, d) => s + (d.liveStakeLovelace || 0), 0);
  // Largest single delegator by stake - the list order from Koios is not
  // reliably stake-descending, so compute the max explicitly.
  const top = list.reduce((m, d) => (!m || (d.liveStakeLovelace || 0) > (m.liveStakeLovelace || 0)) ? d : m, null);
  setText('d-count', live?.liveDelegators != null ? String(live.liveDelegators) : String(list.length));
  setText('d-stake', fmtAda(live?.liveStake));
  setText('d-active', live?.activeStake != null ? fmtAda(live.activeStake) : '—');
  setText('d-top', top ? fmtAda(top.liveStake) : '—');
  setText('d-top-sub', top ? (top.isOwner ? 'your pledge' : shortStake(top.stake)) : '—');
  setText('d-pledge', fmtAda(live?.livePledge));
  setText('d-pledge-sub', live ? `declared ${fmtAda(live.declaredPledge)}` : '—');
  if (live && live.declaredPledge != null && live.livePledge != null) {
    const pEl = document.getElementById('d-pledge');
    if (pEl) pEl.classList.add(live.livePledge >= live.declaredPledge ? 'v-good' : 'v-warn');
  }
  setText('d-sat', live?.liveSaturation != null ? (live.liveSaturation * 100).toFixed(2) : '—');

  // Churn: delegator count vs previous epoch from history cache (cheap, optional).
  let churnNote = '';
  try {
    const hist = await readModel.getEpochHistory(0, 9_999_999);
    const withDeleg = (hist || []).filter((r) => r && r.delegators != null).sort((a, b) => a.epoch - b.epoch);
    // Track the latest epoch for the deep-dive stake-history cache.
    if (Array.isArray(hist) && hist.length) {
      _currentEpoch = hist.reduce((mx, r) => Math.max(mx, r.epoch || 0), 0) || null;
    }
    if (withDeleg.length >= 2) {
      const cur = withDeleg[withDeleg.length - 1].delegators;
      const prev = withDeleg[withDeleg.length - 2].delegators;
      const diff = cur - prev;
      if (diff !== 0) churnNote = ` · ${diff > 0 ? '+' : ''}${diff} vs last epoch`;
    }
  } catch { /* ignore */ }
  setText('d-count-sub', `live${churnNote}`);

  // Dust filter (default ON): hide delegators under 5 ₳. Totals/hero stay
  // Build the unified table: merge the stake list with loyalty data (keyed by
  // stake address), score it, and render with sort buttons + pagination.
  _duOwners = new Set(list.filter((d) => d.isOwner).map((d) => d.stake));
  _duTotalStake = totalStakeLov;

  async function buildUnified(forceRecompute) {
    // Start from the stake list (every current delegator with live stake).
    const byStake = new Map(list.map((d) => [d.stake, { ...d }]));
    // Merge loyalty (db-sync) if available.
    const loyRows = await fetchLoyaltyData(forceRecompute);
    if (loyRows && loyRows.length) {
      const { map } = scoreLoyalty(loyRows);
      for (const [stake, base] of byStake) {
        const loy = map.get(stake);
        if (loy) Object.assign(base, loy);
      }
    }
    _duRows = Array.from(byStake.values());
    renderUnified();
  }

  const dustEl = document.getElementById('d-dust');
  if (dustEl) dustEl.addEventListener('change', () => { _duPage = 0; renderUnified(); });

  // Search-and-jump.
  const sInput = document.getElementById('d-search-input');
  const sGo = document.getElementById('d-search-go');
  const sClear = document.getElementById('d-search-clear');
  const sMsg = document.getElementById('d-search-msg');
  if (sGo) sGo.addEventListener('click', () => jumpToStake(sInput?.value));
  if (sInput) sInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') jumpToStake(sInput.value); });
  if (sClear) sClear.addEventListener('click', () => { if (sInput) sInput.value = ''; if (sMsg) sMsg.textContent = ''; });
  if (sMsg) sMsg.addEventListener('click', (e) => { const f = e.target.closest('[data-copy]'); if (f) copyStake(f.getAttribute('data-copy'), null); });

  // Sort buttons.
  const btnLoy = document.getElementById('sort-loyalty');
  const btnStk = document.getElementById('sort-stake');
  const setSort = (mode) => {
    _duSort = mode; _duPage = 0;
    btnLoy?.classList.toggle('active', mode === 'loyalty');
    btnStk?.classList.toggle('active', mode === 'stake');
    renderUnified();
  };
  btnLoy?.addEventListener('click', () => setSort('loyalty'));
  btnStk?.addEventListener('click', () => setSort('stake'));

  // Refresh recomputes loyalty.
  const refreshBtn = document.getElementById('loy-refresh');
  if (refreshBtn) refreshBtn.addEventListener('click', () => buildUnified(true));

  // If no loyalty source, hide the legend + default to stake sort.
  if (!registry.can(DataKind.DELEGATOR_LOYALTY)) {
    const lg = document.getElementById('d-legend');
    if (lg) {
      lg.classList.add('loy-legend-na');
      lg.innerHTML = '<span class="loy-na">\u24d8 Loyalty ranking (tenure \u00d7 stake-weight) needs db-sync or Blockfrost. '
        + 'Connected to Koios only, so the table shows current live stake. '
        + 'Add db-sync or a Blockfrost key from Settings to rank by loyalty.</span>';
    }
    const lb = document.getElementById('sort-loyalty'); if (lb) lb.style.display = 'none';
    const rb = document.getElementById('loy-refresh'); if (rb) rb.style.display = 'none';
    setSort('stake');
  }

  setLoadProgress(90, 'Scoring loyalty\u2026', 99);
  await buildUnified(false);
  stopLoadCreep();
}

export function unmountDelegators() { stopLoadCreep(); closeDeepDive(); }
