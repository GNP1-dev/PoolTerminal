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

    /* Deep-dive modal */
    .dd-backdrop { position: fixed; inset: 0; background: rgba(5,8,12,0.72); backdrop-filter: blur(3px);
      display: flex; align-items: center; justify-content: center; z-index: 9000; }
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
    .dd-journey { display: flex; align-items: stretch; gap: 0; overflow-x: auto; padding: 8px 2px 18px; }
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
  </style>
  <div class="pt-delegators" id="pt-delegators">
    <div class="pt-hero-row pt-hero-row-5">
      <div class="pt-hero-card"><div class="pt-hero-label">Delegators</div><div class="pt-hero-value" id="d-count">—</div><div class="pt-hero-sub" id="d-count-sub">live</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Live stake</div><div class="pt-hero-value" id="d-stake">—<span class="pt-hero-unit">₳</span></div><div class="pt-hero-sub" id="d-stake-sub">delegated</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Top delegator</div><div class="pt-hero-value" id="d-top">—<span class="pt-hero-unit">₳</span></div><div class="pt-hero-sub" id="d-top-sub">largest single</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Pledge</div><div class="pt-hero-value" id="d-pledge">—<span class="pt-hero-unit">₳</span></div><div class="pt-hero-sub" id="d-pledge-sub">live vs declared</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Saturation</div><div class="pt-hero-value" id="d-sat">—<span class="pt-hero-unit">%</span></div><div class="pt-hero-sub" id="d-sat-sub">of cap</div></div>
    </div>

    <div class="pt-panel">
      <div class="pt-panel-header">
        <span class="pt-panel-title">Delegators</span>
        <span class="pt-panel-meta v-muted" id="d-meta">—</span>
        <label class="d-filter" style="margin-left:auto;display:flex;align-items:center;gap:6px;cursor:pointer;font:400 11px ui-monospace,monospace;color:var(--pt-text-secondary);">
          <input type="checkbox" id="d-dust" checked style="cursor:pointer;">
          Hide &lt; 5 ₳
        </label>
      </div>
      <div class="pt-tbl-wrap" id="d-table"></div>
    </div>
  </div>`;

const fmtAda = (n) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtAdaFull = (n) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 });
const shortStake = (s) => !s ? '—' : `${s.slice(0, 12)}…${s.slice(-6)}`;

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
          <button class="dd-close" id="dd-close">Close ✕</button>
        </div>
        <div class="dd-body" id="dd-body">
          <div class="dd-loading">Fetching delegation history…</div>
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
  const fmt = (n) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const lastIdx = runs.length - 1;
  const hops = runs.map((r, i) => {
    const isUs = r.poolId === OUR_POOL;
    const col = poolColor(r.poolId, isUs);
    const tkr = r.ticker || (r.poolId ? r.poolId.slice(0, 9) + '…' : '?');
    const nm = r.name || '';
    const entry = `<div class="dd-flow"><span class="dd-flow-l">in · ep ${r.entryEpoch ?? '?'}</span><span class="dd-flow-v">${fmt(r.entryStake)} ₳</span></div>`;
    const exit = r.isCurrent
      ? `<div class="dd-flow dd-here"><span class="dd-flow-l">still here</span><span class="dd-flow-v">${fmt(r.exitStake)} ₳ now</span></div>`
      : `<div class="dd-flow"><span class="dd-flow-l">out · ep ${r.exitEpoch ?? '?'}</span><span class="dd-flow-v">${fmt(r.exitStake)} ₳</span></div>`;
    const node = `
      <div class="dd-node${isUs ? ' dest' : ''}" style="background:${col}">
        ${isUs ? '<span class="you">your pool</span>' : ''}
        <div class="tkr">${tkr}</div>
        <div class="nm">${nm}</div>
        ${entry}
        ${exit}
      </div>`;
    const arrow = i < lastIdx
      ? `<div class="dd-arrow"><span class="ln">→</span><span class="at">ep ${runs[i + 1].entryEpoch ?? '?'}</span></div>`
      : '';
    return `<div class="dd-hop">${node}${arrow}</div>`;
  }).join('');
  return `<div class="dd-journey">${hops}</div>`;
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
  if (!detail) { body.innerHTML = '<div class="dd-loading">Could not load delegator detail.</div>'; return; }

  // Resolve pool tickers/names for each run (cached; usually 1–3 distinct pools).
  const runs = Array.isArray(detail.runs) ? detail.runs.slice() : [];
  await Promise.all(runs.map(async (r) => {
    if (!r.poolId) return;
    const m = await blockfrost.getPoolMeta(r.poolId);
    if (m) { r.ticker = m.ticker; r.name = m.name; }
  }));

  // Origin note (the pool they switched from to join us).
  let originHtml = '';
  if (detail.cameFrom) {
    const m = await blockfrost.getPoolMeta(detail.cameFrom);
    const label = m && m.ticker ? m.ticker : (detail.cameFrom.slice(0, 12) + '…');
    originHtml = `<div class="dd-origin-note">Joined your pool from <b>${label}</b>.</div>`;
  } else {
    originHtml = `<div class="dd-origin-note">Your pool appears to be their first (or earliest tracked) delegation.</div>`;
  }

  const drep = detail.drepId ? `<span class="dd-drep">DRep</span>` : '';
  const fmt = (n) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });

  body.innerHTML = `
    <div class="dd-stats">
      <div class="dd-stat"><div class="l">Balance</div><div class="v">${fmt(detail.balance)}<span class="u">₳</span></div></div>
      <div class="dd-stat"><div class="l">Rewards earned</div><div class="v">${fmt(detail.rewardsSum)}<span class="u">₳</span></div></div>
      <div class="dd-stat"><div class="l">Withdrawn</div><div class="v">${fmt(detail.withdrawalsSum)}<span class="u">₳</span></div></div>
      <div class="dd-stat"><div class="l">Since epoch</div><div class="v">${detail.sinceEpoch ?? '—'}${drep}</div></div>
    </div>
    <div class="dd-section-title">Pool movement</div>
    ${originHtml}
    ${renderJourney(runs)}
  `;
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

export async function mountDelegators(canvas) {
  canvas.innerHTML = DELEGATORS_HTML;
  const root = canvas.querySelector('#pt-delegators');

  // Optional Blockfrost enrichment — idempotent, no-op without a key.
  try { await readModel.ensureBlockfrost(); } catch { /* ignore */ }

  // Can any source answer delegator data? If not, friendly prompt.
  if (!registry.can(DataKind.DELEGATOR_LIST) || !registry.can(DataKind.POOL_LIVE)) {
    renderEmpty(root);
    return;
  }

  setText('d-meta', 'loading…');
  let live = null, list = [];
  try {
    live = await registry.get(DataKind.POOL_LIVE);
    list = await registry.get(DataKind.DELEGATOR_LIST);
  } catch (e) {
    console.warn('[delegators] load failed:', e.message ?? e);
    renderEmpty(root);
    return;
  }
  if (!Array.isArray(list)) list = [];

  // Hero stats (computed on the FULL list — totals are always whole-pool).
  const totalStakeLov = list.reduce((s, d) => s + (d.liveStakeLovelace || 0), 0);
  const top = list[0];
  setText('d-count', live?.liveDelegators != null ? String(live.liveDelegators) : String(list.length));
  setText('d-stake', fmtAda(live?.liveStake));
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
  // whole-pool; only the table list is filtered. Re-renders on toggle.
  const who = registry.describe(DataKind.DELEGATOR_LIST);
  const DUST_ADA = 5;
  function renderList() {
    const dustOn = !!document.getElementById('d-dust')?.checked;
    const shown = dustOn ? list.filter((d) => (d.liveStake || 0) >= DUST_ADA) : list;
    const hidden = list.length - shown.length;
    setText('d-meta', `${shown.length} shown${hidden ? ` · ${hidden} dust hidden` : ''} · source: ${who?.name ?? '—'}`);
    renderTable(canvas.querySelector('#d-table'), shown, totalStakeLov);
  }
  const dustEl = document.getElementById('d-dust');
  if (dustEl) dustEl.addEventListener('change', renderList);
  renderList();
}

export function unmountDelegators() { closeDeepDive(); }
