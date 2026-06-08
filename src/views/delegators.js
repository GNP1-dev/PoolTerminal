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
    .pt-delegators tbody tr:hover { background: var(--pt-bg-strip); }
    .pt-delegators .addr { font-size: 10px; color: var(--pt-text-secondary); }
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
      </div>
      <div class="pt-tbl-wrap" id="d-table"></div>
    </div>
  </div>`;

const fmtAda = (n) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
const fmtAdaFull = (n) => n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 6 });
const shortStake = (s) => !s ? '—' : `${s.slice(0, 12)}…${s.slice(-6)}`;

function setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt; }

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
    return `<tr>
      <td class="left">${i + 1}</td>
      <td class="left addr">${shortStake(d.stake)}${badge}</td>
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

  // Hero stats
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
    if (withDeleg.length >= 2) {
      const cur = withDeleg[withDeleg.length - 1].delegators;
      const prev = withDeleg[withDeleg.length - 2].delegators;
      const diff = cur - prev;
      if (diff !== 0) churnNote = ` · ${diff > 0 ? '+' : ''}${diff} vs last epoch`;
    }
  } catch { /* ignore */ }
  setText('d-count-sub', `live${churnNote}`);

  // Source credit + table
  const who = registry.describe(DataKind.DELEGATOR_LIST);
  setText('d-meta', `${list.length} shown · source: ${who?.name ?? '—'}`);
  renderTable(canvas.querySelector('#d-table'), list, totalStakeLov);
}

export function unmountDelegators() { /* no timers yet; placeholder for symmetry */ }
