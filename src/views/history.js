/**
 * PoolTerminal — HISTORY view.
 *
 * The view gLiveView structurally cannot have: persistent per-epoch history.
 * Reads entirely from the local read-model cache (epoch_snapshots), which the
 * collector seeds from Koios on first run and extends each epoch. No node load.
 *
 * Layout (DESIGN.md view grammar):
 *   hero row  — lifetime blocks · epochs tracked · avg luck · delegators · rewards
 *   2-col grid — Blocks/epoch · Delegators · Luck% · Active stake  (inline SVG)
 *   bottom    — full epoch table, newest first
 *
 * Charts are hand-rolled SVG (no chart lib, matching the app's no-bundler stack)
 * and use the design tokens so they theme with the rest of the terminal.
 */

import * as readModel from '../data/read-model.js';

const HISTORY_HTML = `
  <style>
    .pt-history { display: flex; flex-direction: column; gap: var(--pt-gap, 8px); padding: 8px; height: 100%; overflow-y: auto; }
    .pt-history .pt-hero-row-5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: var(--pt-gap, 8px); }
    .pt-history .pt-hero-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pt-history .pt-hist-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--pt-gap, 8px); }
    .pt-history .pt-chart-body { padding: 8px 10px 4px; }
    .pt-history svg { width: 100%; height: auto; display: block; }
    .pt-history .pt-chart-axis { font: 400 10px ui-monospace, monospace; fill: var(--pt-text-muted); }
    .pt-history .pt-tbl-wrap { max-height: 340px; overflow: auto; }
    .pt-history table { width: 100%; border-collapse: collapse; font: 400 11px ui-monospace, monospace; white-space: nowrap; }
    .pt-history thead th { position: sticky; top: 0; background: var(--pt-bg-strip); color: var(--pt-text-secondary);
      text-align: right; font-weight: 500; padding: 6px 10px; border-bottom: 0.5px solid var(--pt-border);
      text-transform: uppercase; letter-spacing: 0.4px; font-size: 10px; }
    .pt-history thead th:first-child { text-align: left; }
    .pt-history thead th.grp { border-left: 0.5px solid var(--pt-border); color: var(--pt-accent-blue); }
    .pt-history tbody td { text-align: right; padding: 5px 10px; border-bottom: 0.5px solid var(--pt-border);
      color: var(--pt-text-primary); }
    .pt-history tbody td:first-child { text-align: left; color: var(--pt-text-secondary); }
    .pt-history tbody td.grp { border-left: 0.5px solid var(--pt-border); }
    .pt-history tbody td.total { color: var(--pt-accent-blue); font-weight: 500; }
    .pt-history tbody tr:hover { background: var(--pt-bg-strip); }
    .pt-history .pt-hist-empty { padding: 40px; text-align: center; color: var(--pt-text-muted); }
    .pt-history .v-good { color: var(--pt-status-good); }
    .pt-history .v-warn { color: var(--pt-status-warn); }
    .pt-history .v-muted { color: var(--pt-text-muted); }
  </style>
  <div class="pt-history" id="pt-history">
    <div class="pt-hero-row pt-hero-row-5">
      <div class="pt-hero-card"><div class="pt-hero-label">Lifetime blocks</div><div class="pt-hero-value" id="h-blocks">—</div><div class="pt-hero-sub" id="h-blocks-sub">—</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Epochs tracked</div><div class="pt-hero-value" id="h-epochs">—</div><div class="pt-hero-sub" id="h-epochs-sub">—</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Avg luck</div><div class="pt-hero-value" id="h-luck">—<span class="pt-hero-unit">%</span></div><div class="pt-hero-sub" id="h-luck-sub">vs ideal</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Delegators</div><div class="pt-hero-value" id="h-deleg">—</div><div class="pt-hero-sub" id="h-deleg-sub">—</div></div>
      <div class="pt-hero-card"><div class="pt-hero-label">Member rewards</div><div class="pt-hero-value" id="h-rewards">—<span class="pt-hero-unit">₳</span></div><div class="pt-hero-sub" id="h-rewards-sub">lifetime tracked</div></div>
    </div>

    <div class="pt-hist-grid">
      <div class="pt-panel"><div class="pt-panel-header"><span class="pt-panel-title">Blocks per epoch</span><span class="pt-panel-meta v-muted">dashed = ideal</span></div><div class="pt-chart-body" id="chart-blocks"></div></div>
      <div class="pt-panel"><div class="pt-panel-header"><span class="pt-panel-title">Delegators</span><span class="pt-panel-meta v-muted" id="chart-deleg-meta">—</span></div><div class="pt-chart-body" id="chart-deleg"></div></div>
      <div class="pt-panel"><div class="pt-panel-header"><span class="pt-panel-title">Luck %</span><span class="pt-panel-meta v-muted">100% = ideal</span></div><div class="pt-chart-body" id="chart-luck"></div></div>
      <div class="pt-panel"><div class="pt-panel-header"><span class="pt-panel-title">Active stake</span><span class="pt-panel-meta v-muted" id="chart-stake-meta">—</span></div><div class="pt-chart-body" id="chart-stake"></div></div>
    </div>

    <div class="pt-panel">
      <div class="pt-panel-header"><span class="pt-panel-title">Epoch history</span><span class="pt-panel-meta v-muted" id="hist-tbl-meta">—</span></div>
      <div class="pt-tbl-wrap" id="hist-table"></div>
    </div>
  </div>`;

// ---- formatting -----------------------------------------------------------

function fmtAdaShort(ada) {
  if (ada == null) return '—';
  if (ada >= 1e9) return (ada / 1e9).toFixed(2) + 'B';
  if (ada >= 1e6) return (ada / 1e6).toFixed(2) + 'M';
  if (ada >= 1e3) return (ada / 1e3).toFixed(1) + 'K';
  return Math.round(ada).toString();
}
function fmtNum(n) { return n == null ? '—' : Number(n).toLocaleString('en-US'); }
function luckOf(r) { return r.ideal && r.ideal > 0 ? (r.adopted / r.ideal) * 100 : null; }

// ---- inline SVG charts ----------------------------------------------------

const W = 820, H = 190, PAD = 22;

function barChart(values, { color = 'var(--pt-accent-blue)', refLine = null } = {}) {
  const max = Math.max(1, ...values);
  const n = values.length || 1;
  const innerW = W - PAD * 2, innerH = H - PAD * 2;
  const bw = innerW / n;
  let bars = '';
  values.forEach((v, i) => {
    const bh = (v / max) * innerH;
    const x = PAD + i * bw;
    const y = PAD + innerH - bh;
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(0.6, bw - 0.6).toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}"/>`;
  });
  let ref = '';
  if (refLine != null) {
    const ry = PAD + innerH - (refLine / max) * innerH;
    ref = `<line x1="${PAD}" y1="${ry.toFixed(1)}" x2="${W - PAD}" y2="${ry.toFixed(1)}" stroke="var(--pt-text-muted)" stroke-dasharray="3 3" stroke-width="1"/>`;
  }
  return svgWrap(`${ref}${bars}`, max);
}

function areaChart(values, { color = 'var(--pt-accent-blue)', fill = 'var(--pt-accent-blue-soft)' } = {}) {
  if (!values.length) return svgWrap('', 0);
  const max = Math.max(...values), min = Math.min(...values);
  const range = (max - min) || 1;
  const innerW = W - PAD * 2, innerH = H - PAD * 2;
  const pts = values.map((v, i) => {
    const x = PAD + (i / (values.length - 1 || 1)) * innerW;
    const y = PAD + innerH - ((v - min) / range) * innerH;
    return [x, y];
  });
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${(PAD + innerW).toFixed(1)} ${(PAD + innerH).toFixed(1)} L${PAD.toFixed(1)} ${(PAD + innerH).toFixed(1)} Z`;
  const body = `<path d="${area}" fill="${fill}" opacity="0.3"/><path d="${line}" fill="none" stroke="${color}" stroke-width="1.5"/>`;
  return svgWrap(body, max, min);
}

function svgWrap(body, max, min = 0) {
  const innerH = H - PAD * 2;
  const yMax = `<text class="pt-chart-axis" x="2" y="${(PAD + 8).toFixed(0)}">${fmtAxis(max)}</text>`;
  const yMin = `<text class="pt-chart-axis" x="2" y="${(PAD + innerH).toFixed(0)}">${fmtAxis(min)}</text>`;
  const base = `<line x1="${PAD}" y1="${(PAD + innerH).toFixed(1)}" x2="${W - PAD}" y2="${(PAD + innerH).toFixed(1)}" stroke="var(--pt-border)" stroke-width="0.5"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">${base}${body}${yMax}${yMin}</svg>`;
}
function fmtAxis(v) {
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(0) + 'K';
  return (Math.round(v * 100) / 100).toString();
}

// ---- table ----------------------------------------------------------------

function luckClass(luck) {
  if (luck == null) return 'v-muted';
  if (luck >= 100) return 'v-good';
  if (luck >= 70) return '';
  return 'v-warn';
}

/** ADA to a compact fixed string for reward cells. '—' for null/undefined. */
function fmtAdaCell(v) {
  if (v == null) return '—';
  if (v === 0) return '0';
  if (Math.abs(v) >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

/**
 * Split an epoch's rewards into five finalised components:
 *   deleg (member) · SPO pledge · SPO min fee · SPO margin · total payout.
 * '—' when not yet published; 0s for a zero-block epoch (finalised, not unknown).
 *   R = member + leader; minFee = min(fixedCost,R);
 *   marginEarn = margin × max(0,R−minFee); pledge = leader − minFee − marginEarn.
 */
function rewardSplit(r, isCurrent) {
  const blank = ['—', '—', '—', '—', '—'];
  if (isCurrent) return blank;
  const member = r.memberRewards;
  const leader = r.leaderReward;                        // undefined = not fetched/published
  if (member == null || leader == null) return blank;
  const R = member + leader;
  const fixed = r.fixedCost || 0;
  const minFee = Math.min(fixed, R);
  const marginEarn = (r.margin || 0) * Math.max(0, R - minFee);
  const pledge = Math.max(0, leader - minFee - marginEarn);
  return [member, pledge, minFee, marginEarn, member + leader].map(fmtAdaCell);
}

function renderTable(rows, currentEpoch) {
  const head = `<table><thead><tr>
    <th>Epoch</th><th>Blocks</th><th>Ideal</th><th>Luck</th><th>Delegators</th><th>Active stake</th>
    <th class="grp">Deleg rwd</th><th>SPO pledge</th><th>SPO fee</th><th>SPO margin</th><th>Total payout</th>
  </tr></thead><tbody>`;
  const body = rows.map((r) => {
    const isCurrent = r.epoch === currentEpoch;
    // Current (in-progress) epoch: blocks-so-far is fine, but luck is not yet
    // meaningful (the epoch can still produce), so show '—', not 0%.
    const luck = isCurrent ? null : luckOf(r);
    const [del, pledge, fee, margin, total] = rewardSplit(r, isCurrent);
    return `<tr>
      <td>${r.epoch}</td>
      <td>${r.adopted ?? '—'}</td>
      <td>${r.ideal != null ? r.ideal.toFixed(2) : '—'}</td>
      <td class="${luckClass(luck)}">${luck != null ? Math.round(luck) + '%' : '—'}</td>
      <td>${fmtNum(r.delegators)}</td>
      <td>${fmtAdaShort(r.activeStake)}</td>
      <td class="grp">${del}</td>
      <td>${pledge}</td>
      <td>${fee}</td>
      <td>${margin}</td>
      <td class="total">${total}</td>
    </tr>`;
  }).join('');
  return head + body + '</tbody></table>';
}

// ---- mount ----------------------------------------------------------------

export async function mountHistory(canvas) {
  canvas.innerHTML = HISTORY_HTML;

  let rows = [];
  let meta = null;
  try {
    rows = await readModel.getEpochHistory(0, 9_999_999);
    meta = await readModel.getHistoryMeta();
  } catch (err) {
    console.warn('[history] load failed:', err.message ?? err);
  }
  rows = rows.filter((r) => r && r.epoch != null).sort((a, b) => a.epoch - b.epoch);

  if (!rows.length) {
    const root = canvas.querySelector('#pt-history');
    if (root) root.innerHTML = '<div class="pt-hist-empty">No cached history yet. Connect in LIVE mode with a history source (db-sync or Koios) enabled and let it backfill, then return here.</div>';
    return;
  }

  // --- summary hero ---
  const maxEpoch = rows[rows.length - 1].epoch;      // the in-progress current epoch
  const totalBlocks = rows.reduce((s, r) => s + (r.adopted || 0), 0);  // lifetime, incl. current
  // Avg luck = lifetime blocks / lifetime ideal — the honest ratio. Only over
  // CLOSED epochs that have a known ideal (exclude the in-progress current epoch
  // and any closed epoch whose ideal hasn't been published yet), so a partial
  // epoch can't distort it.
  const luckRows = rows.filter((r) => r.epoch !== maxEpoch && r.ideal != null);
  const luckBlocks = luckRows.reduce((s, r) => s + (r.adopted || 0), 0);
  const luckIdeal = luckRows.reduce((s, r) => s + (r.ideal || 0), 0);
  const avgLuck = luckIdeal > 0 ? Math.round((luckBlocks / luckIdeal) * 100) : null;
  const totalRewards = rows.reduce((s, r) => s + (r.memberRewards || 0), 0);
  const latest = rows[rows.length - 1];
  const latestDeleg = [...rows].reverse().find((r) => r.delegators != null);
  const firstEpoch = rows[0].epoch, lastEpoch = latest.epoch;

  const set = (id, v) => { const el = canvas.querySelector('#' + id); if (el) el.textContent = v; };
  set('h-blocks', fmtNum(totalBlocks));
  set('h-blocks-sub', `${rows.filter((r) => (r.adopted || 0) > 0).length} producing epochs`);
  set('h-epochs', fmtNum(rows.length));
  set('h-epochs-sub', `epoch ${firstEpoch} → ${lastEpoch}`);
  set('h-luck', avgLuck != null ? avgLuck : '—');
  set('h-deleg', latestDeleg ? fmtNum(latestDeleg.delegators) : '—');
  set('h-deleg-sub', latestDeleg ? `as of epoch ${latestDeleg.epoch}` : '—');
  set('h-rewards', fmtAdaShort(totalRewards));

  // --- charts ---
  // Fill-forward nulls so the in-progress live epoch (briefly missing
  // delegators/stake) doesn't drop the area charts to zero at the right edge.
  const fillFwd = (vals) => { let last = 0; return vals.map((v) => { if (v != null) { last = v; return v; } return last; }); };
  const put = (id, svg) => { const el = canvas.querySelector('#' + id); if (el) el.innerHTML = svg; };
  put('chart-blocks', barChart(rows.map((r) => r.adopted || 0), {
    refLine: rows.reduce((s, r) => s + (r.ideal || 0), 0) / rows.length,
  }));
  put('chart-deleg', areaChart(fillFwd(rows.map((r) => r.delegators))));
  put('chart-luck', barChart(rows.map((r) => luckOf(r) || 0), { color: 'var(--pt-accent-blue-bright)', refLine: 100 }));
  put('chart-stake', areaChart(fillFwd(rows.map((r) => r.activeStake)), { color: 'var(--pt-status-good)', fill: 'var(--pt-status-good)' }));

  set('chart-deleg-meta', latestDeleg ? `${fmtNum(latestDeleg.delegators)} now` : '—');
  set('chart-stake-meta', `${fmtAdaShort(latest.activeStake)} ₳`);

  // --- table (newest first) ---
  const tbl = canvas.querySelector('#hist-table');
  if (tbl) tbl.innerHTML = renderTable([...rows].reverse(), maxEpoch);
  let metaText = `${rows.length} epochs`;
  if (meta && meta.source) {
    metaText += ` · Data: ${meta.source}`;
    if (meta.source === 'dbsync' && meta.schema) {
      metaText += ` v${meta.schema}`;
      if (meta.stale) metaText += ` ⚠ tested ${meta.tested} — verify after db-sync upgrade`;
    }
  }
  set('hist-tbl-meta', metaText);
}

export function unmountHistory() { /* static view — nothing to tear down */ }
