/**
 * PoolTerminal - DATA SOURCES view.
 *
 * An honest, at-a-glance map of where every piece of data in the app comes from,
 * and what is unavailable or reduced without a given source. Two categories:
 *
 *   • From your node  - the SSH/local connection (tip, KES, peers, blocks, ...).
 *     Always the node; available only while connected.
 *   • External data   - governed by the capability registry, where db-sync,
 *     Koios and Blockfrost compete. The active source per feature is read
 *     live from the registry, so this screen is always truthful.
 *
 * This is read-only - it reflects the current setup; you change sources in the
 * setup wizard or Settings.
 */

import { registry, DataKind } from '../data/capabilities.js';
import { getMode } from '../data/index.js';
import { getSession } from '../data/session.js';

// Friendly colour class from a source id (handles '-live' suffix).
function badgeClass(id) {
  if (!id) return 'ds-none';
  const base = id.replace('-live', '');
  if (base === 'node' || base === 'node-cli' || base === 'cli') return 'ds-node';
  if (base === 'dbsync') return 'ds-dbsync';
  if (base === 'koios') return 'ds-koios';
  if (base === 'blockfrost') return 'ds-bf';
  return 'ds-other';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── node-sourced features (the SSH/local connection) ─────────────────────────
const NODE_FEATURES = [
  { label: 'Chain tip & sync', desc: 'Current block and slot, and how synced your node is.' },
  { label: 'Block production & schedule', desc: 'Leader slots, adopted/confirmed blocks, ideal count.', note: 'Always read from your node - it is the authority for block production.' },
  { label: 'KES key status', desc: 'Periods remaining and expiry date.' },
  { label: 'Peers', desc: 'Inbound and outbound connections and latency.' },
  { label: 'Mempool', desc: 'Pending transactions and capacity.' },
  { label: 'Chain pulse', desc: 'Recent block timing and density.' },
  { label: 'Host resources', desc: 'CPU, memory and node process metrics.' },
];

// ── external features (registry-governed) ────────────────────────────────────
// needs: minimum source(s) required; enhance: what a better source adds.
const POOL_FEATURES = [
  { label: 'Pool summary', desc: 'Live and active stake, saturation, pledge and counts.', kind: DataKind.POOL_LIVE, needs: 'Koios or db-sync' },
  { label: 'Live notifications', desc: 'Delegator joins, leaves and stake changes.', kind: DataKind.DELEGATOR_LIST_LIVE,
    needs: 'Koios', enhance: 'With db-sync connected, joins and leaves are detected instantly. Live balances currently come from Koios; full db-sync live data is planned.' },
  { label: 'Delegator list', desc: 'Current delegators and their stake.', kind: DataKind.DELEGATOR_LIST, needs: 'Koios or db-sync' },
  { label: 'Delegator deep-dive', desc: 'One delegator: balance, rewards, tenure and pool trail.', kind: DataKind.DELEGATOR_DETAIL, needs: 'Koios or Blockfrost' },
  { label: 'Loyalty leaderboard', desc: 'Longest-tenured delegators.', kind: DataKind.DELEGATOR_LOYALTY, needs: 'db-sync', noteUnavail: 'Without db-sync, the tenure leaderboard is unavailable.' },
];
const HISTORY_FEATURES = [
  { label: 'Epoch history', desc: 'Blocks, stake, delegators and rewards per epoch.', kind: DataKind.EPOCH_BLOCKS,
    needs: 'Koios or db-sync', enhance: 'db-sync gives full, instant history. Koios works but is rate-limited on the free tier.' },
  { label: 'Pool parameters', desc: 'Margin, fixed cost and pledge.', kind: DataKind.POOL_PARAMS, needs: 'Koios or db-sync' },
];

function nodeRow(f, live) {
  const badge = live
    ? `<span class="ds-badge ds-node">Node</span>`
    : `<span class="ds-badge ds-none">Connect to view</span>`;
  const note = f.note ? `<div class="ds-note">${esc(f.note)}</div>` : '';
  return `<div class="ds-row"><div class="ds-row-main"><div class="ds-row-l">${esc(f.label)}</div>
    <div class="ds-row-d">${esc(f.desc)}</div>${note}</div><div class="ds-row-src">${badge}</div></div>`;
}

function extRow(f) {
  let active = null;
  try { active = registry.describe(f.kind); } catch { active = null; }
  const can = active != null;
  const badge = can
    ? `<span class="ds-badge ${badgeClass(active.id)}">${esc(active.name)}${active.version ? ` <span class="ds-ver">${esc(active.version)}</span>` : ''}</span>`
    : `<span class="ds-badge ds-none">Not available</span>`;
  let note = '';
  if (!can) note = `<div class="ds-note ds-note-warn">${esc(f.noteUnavail || `Needs ${f.needs}.`)}</div>`;
  else if (f.enhance) note = `<div class="ds-note">${esc(f.enhance)}</div>`;
  return `<div class="ds-row"><div class="ds-row-main"><div class="ds-row-l">${esc(f.label)}</div>
    <div class="ds-row-d">${esc(f.desc)}</div>${note}</div><div class="ds-row-src">${badge}</div></div>`;
}

function summaryHtml(live) {
  const has = (id) => registry.all().some((s) => s.id === id && safeReach(s));
  const dbsync = registry.all().find((s) => s.id === 'dbsync');
  const dbsyncOn = dbsync && safeReach(dbsync);
  const dbsyncVer = dbsyncOn ? safeCall(() => dbsync.version()) : null;
  const koiosOn = has('koios') || has('koios-live');
  const bf = registry.all().find((s) => s.id === 'blockfrost');
  const bfOn = bf && safeReach(bf);

  const chip = (cls, label, status, on) =>
    `<div class="ds-chip ${on ? '' : 'ds-chip-off'}"><span class="ds-dot ${cls}"></span>` +
    `<div><div class="ds-chip-l">${esc(label)}</div><div class="ds-chip-s">${esc(status)}</div></div></div>`;

  const sess = (() => { try { return getSession(); } catch { return {}; } })();
  const transport = sess && sess.transport === 'local' ? 'On this machine (local)'
    : sess && sess.transport ? 'Over SSH' : '';

  return `<div class="ds-chips">` +
    chip('ds-node', 'Node', live ? (transport || 'Connected') : 'Not connected', live) +
    chip('ds-dbsync', 'db-sync', dbsyncOn ? `Active${dbsyncVer ? ` - schema ${dbsyncVer}` : ''}` : 'Not configured', dbsyncOn) +
    chip('ds-koios', 'Koios', koiosOn ? 'Available (public API)' : 'Unavailable', koiosOn) +
    chip('ds-bf', 'Blockfrost', bfOn ? 'Active' : 'Not configured', bfOn) +
  `</div>`;
}

function safeReach(s) { try { return s.reachable(); } catch { return false; } }
function safeCall(fn) { try { return fn(); } catch { return null; } }

function ensureStyle() {
  if (document.getElementById('ds-style')) return;
  const el = document.createElement('style');
  el.id = 'ds-style';
  el.textContent = `
    /* Outer wrap fills the canvas; the header is fixed and the grid fills the rest. */
    .ds-wrap { flex: 1 1 auto; min-height: 0; box-sizing: border-box; padding: 4px 2px 6px;
      display: flex; flex-direction: column; overflow: hidden; }
    .ds-head h2 { font-size: 18px; font-weight: 800; margin: 0 0 2px; color: var(--pt-text-primary, #e6edf3); }
    .ds-head p { font-size: 12px; color: var(--pt-text-muted, #9aa7b4); margin: 0 0 10px; line-height: 1.4; }

    /* 2x2 tile grid filling the remaining height, no page scroll. */
    .ds-grid { flex: 1 1 auto; min-height: 0; display: grid;
      grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 12px; }
    .ds-tile { min-height: 0; display: flex; flex-direction: column;
      background: rgba(120,150,190,0.04); border: 1px solid rgba(120,150,190,0.14);
      border-radius: 12px; padding: 12px 14px; box-sizing: border-box; }
    .ds-tile-h { font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.07em;
      color: var(--pt-text-secondary, #b9c4d0); margin: 0 0 2px; flex: 0 0 auto; }
    .ds-tile-sub { font-size: 11px; color: var(--pt-text-muted, #9aa7b4); margin: 0 0 9px; flex: 0 0 auto; line-height: 1.35; }
    /* Tile body scrolls internally only if its content is taller than the tile. */
    .ds-tile-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
    .ds-tile-body::-webkit-scrollbar { width: 7px; }
    .ds-tile-body::-webkit-scrollbar-thumb { background: rgba(120,150,190,0.25); border-radius: 4px; }

    /* Status chips - stacked vertically inside the top-left tile. */
    .ds-chips { display: flex; flex-direction: column; gap: 8px; }
    .ds-chip { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 9px;
      background: rgba(120,150,190,0.06); border: 1px solid rgba(120,150,190,0.2); }
    .ds-chip-off { opacity: 0.55; }
    .ds-dot { width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
    .ds-chip-l { font-size: 13px; font-weight: 700; color: var(--pt-text-primary, #e6edf3); }
    .ds-chip-s { font-size: 11px; color: var(--pt-text-muted, #9aa7b4); margin-top: 1px; }

    /* Feature rows - compacted for tile density. */
    .ds-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
      padding: 9px 11px; border-radius: 8px; background: rgba(120,150,190,0.04);
      border: 1px solid rgba(120,150,190,0.12); margin-bottom: 7px; }
    .ds-row:last-child { margin-bottom: 0; }
    .ds-row-l { font-size: 13px; font-weight: 600; color: var(--pt-text-primary, #e6edf3); }
    .ds-row-d { font-size: 11.5px; color: var(--pt-text-muted, #9aa7b4); margin-top: 2px; line-height: 1.4; }
    .ds-note { font-size: 11px; color: var(--pt-text-secondary, #b9c4d0); margin-top: 5px; line-height: 1.4;
      border-left: 2px solid rgba(120,150,190,0.3); padding-left: 8px; }
    .ds-note-warn { color: #fbbf24; border-left-color: rgba(251,191,36,0.5); }
    .ds-row-src { flex: 0 0 auto; }
    .ds-badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 20px;
      white-space: nowrap; border: 1px solid; }
    .ds-ver { font-weight: 400; opacity: 0.7; font-family: ui-monospace, monospace; font-size: 10px; }
    .ds-node   { color: #4ade80; border-color: rgba(74,222,128,0.4);  background: rgba(74,222,128,0.1); }
    .ds-dbsync { color: #2dd4bf; border-color: rgba(45,212,191,0.4);  background: rgba(45,212,191,0.1); }
    .ds-koios  { color: #4aa3ff; border-color: rgba(74,163,255,0.4);  background: rgba(74,163,255,0.1); }
    .ds-bf     { color: #a78bfa; border-color: rgba(167,139,250,0.4); background: rgba(167,139,250,0.1); }
    .ds-other  { color: #9aa7b4; border-color: rgba(154,167,180,0.4); background: rgba(154,167,180,0.1); }
    .ds-none   { color: #fb7185; border-color: rgba(251,113,133,0.4); background: rgba(251,113,133,0.08); }
    .ds-dot.ds-node { background: #4ade80; } .ds-dot.ds-dbsync { background: #2dd4bf; }
    .ds-dot.ds-koios { background: #4aa3ff; } .ds-dot.ds-bf { background: #a78bfa; }

    /* Below a narrow width, stack tiles vertically and allow the page to scroll. */
    @media (max-width: 760px) {
      .ds-wrap { overflow-y: auto; }
      .ds-grid { grid-template-columns: 1fr; grid-template-rows: none; }
      .ds-tile { min-height: 180px; }
    }
  `;
  document.head.appendChild(el);
}

let _dsTimer = null;
let _dsSig = '';

// A cheap fingerprint of the current source picture; redraw only when it changes.
function sourceSignature() {
  const kinds = [DataKind.POOL_LIVE, DataKind.DELEGATOR_LIST_LIVE, DataKind.DELEGATOR_LIST,
    DataKind.DELEGATOR_DETAIL, DataKind.DELEGATOR_LOYALTY, DataKind.EPOCH_BLOCKS,
    DataKind.POOL_PARAMS];
  const parts = [getMode()];
  for (const k of kinds) {
    let id = '-';
    try { const d = registry.describe(k); id = d ? d.id : '-'; } catch { id = '-'; }
    parts.push(id);
  }
  return parts.join('|');
}

export function mountDataSources(canvas) {
  ensureStyle();
  draw(canvas);
  _dsSig = sourceSignature();
  if (_dsTimer) clearInterval(_dsTimer);
  // Sources (especially Blockfrost) finish their async health probe shortly
  // after connect. Re-read only when the picture actually changes, preserving
  // scroll - so this never fights the user scrolling once things are stable.
  _dsTimer = setInterval(() => {
    if (!document.body.contains(canvas)) { clearInterval(_dsTimer); _dsTimer = null; return; }
    const sig = sourceSignature();
    if (sig === _dsSig) return;
    _dsSig = sig;
    const wrap = canvas.querySelector('.ds-wrap');
    const y = wrap ? wrap.scrollTop : 0;
    draw(canvas);
    const w2 = canvas.querySelector('.ds-wrap');
    if (w2) w2.scrollTop = y;
  }, 2500);
}

function draw(canvas) {
  const live = getMode() === 'live';
  canvas.innerHTML =
    `<div class="ds-wrap">` +
      `<div class="ds-head"><h2>Data sources</h2>` +
      `<p>Where each part of PoolTerminal gets its data, and what needs a particular source. ` +
      `Change sources in the setup wizard or Settings.</p></div>` +
      `<div class="ds-grid">` +
        // top-left: status
        `<div class="ds-tile">` +
          `<div class="ds-tile-h">Status</div>` +
          `<div class="ds-tile-sub">Connections in use right now.</div>` +
          `<div class="ds-tile-body">` + summaryHtml(live) + `</div>` +
        `</div>` +
        // top-right: node
        `<div class="ds-tile">` +
          `<div class="ds-tile-h">From your node</div>` +
          `<div class="ds-tile-sub">Read directly from the Cardano node over your connection.</div>` +
          `<div class="ds-tile-body">` + NODE_FEATURES.map((f) => nodeRow(f, live)).join('') + `</div>` +
        `</div>` +
        // bottom-left: pool & delegators
        `<div class="ds-tile">` +
          `<div class="ds-tile-h">Pool &amp; delegators</div>` +
          `<div class="ds-tile-sub">Live pool and delegator data from an external source.</div>` +
          `<div class="ds-tile-body">` + POOL_FEATURES.map(extRow).join('') + `</div>` +
        `</div>` +
        // bottom-right: history
        `<div class="ds-tile">` +
          `<div class="ds-tile-h">History</div>` +
          `<div class="ds-tile-sub">Per-epoch records and pool lifecycle.</div>` +
          `<div class="ds-tile-body">` + HISTORY_FEATURES.map(extRow).join('') + `</div>` +
        `</div>` +
      `</div>` +
    `</div>`;
}

export function unmountDataSources() {
  if (_dsTimer) { clearInterval(_dsTimer); _dsTimer = null; }
}
