/**
 * logs.js — Logs tab (READ-ONLY node log queries).
 *
 * Queries the block producer's systemd journal (journald) over the app's
 * existing connection (invoke('ssh_run', …)) — the same transport every other
 * data module uses, so it inherits the live SSH/local session with no new
 * plumbing. Everything here is READ-ONLY: journalctl reads only, bounded line
 * counts, and any user-supplied search term is sanitised before it reaches a
 * shell. There is deliberately NO general terminal.
 *
 * Stage 1: service picker + results pane + one curated query ("Errors &
 * warnings") to prove the connection → command → results path end to end.
 */

import { invoke } from '../data/tauri.js';
import { getMode } from '../data/index.js';
import { getBlockHistory } from '../data/dbsync-query.js';
import { getPropagationHistory } from '../data/read-model.js';

// Propagation history time-window (ms). null = all time. Default 24h so the
// sparkline stays granular instead of squashing months of blocks into one strip.
const PROP_WINDOWS = [
  { id: '1h',  label: '1h',  ms: 3600e3 },
  { id: '6h',  label: '6h',  ms: 6 * 3600e3 },
  { id: '12h', label: '12h', ms: 12 * 3600e3 },
  { id: '24h', label: '24h', ms: 24 * 3600e3 },
  { id: '7d',  label: '7d',  ms: 7 * 24 * 3600e3 },
  { id: 'all', label: 'All', ms: null },
];
let _propWindow = '24h';
import { dbsyncMachine } from '../data/read-model.js';

// The Cardano systemd units typically present on a Guild/CNTools node. The user
// can override the block-producer unit name if theirs differs.
const DEFAULT_BP_UNIT = 'cnode_bp.service';
const DEFAULT_BLOCKLOG_DB = '/opt/cardano/cnode_bp/guild-db/blocklog/blocklog.db';

// Persisted config (unit name + default line bound). Kept in localStorage like
// the app's other lightweight settings.
const LS_KEY = 'pt.logs.cfg.v1';
function loadCfg() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; }
  catch { return {}; }
}
function saveCfg(cfg) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

let _cfg = null;

// ---- READ-ONLY command execution -------------------------------------------
// Run everything at low CPU + IO priority so a query can never compete with
// block production for resources on the BP.
const NICE = 'nice -n 19 ionice -c3';

async function runCmd(command) {
  const r = await invoke('ssh_run', { command });
  if (typeof r === 'string') return r;
  return r?.stdout ?? '';
}

// Build a bounded, read-only journalctl command for a unit. lines caps output;
// sinceHrs optionally limits the time window. No shell metacharacters are ever
// interpolated from user input here — unit is validated, lines is a number.
function journalCmd(unit, opts = {}) {
  const safeUnit = sanitizeUnit(unit);
  // Default to a TIME window, not a line count: the node log is flooded with
  // benign Net.Mux CleanExit notices, so the last N lines cover only seconds.
  // A --since window plus an on-node grep is what surfaces rare, real events.
  const hrs = Math.max(1, Math.min(24 * 30, Number(opts.sinceHrs) || 24));
  const capN = Math.max(1, Math.min(20000, Number(opts.maxLines) || 5000));
  return `${NICE} journalctl -u ${safeUnit} --no-pager --merge --since "${hrs} hours ago" -n ${capN}`;
}

// A systemd unit name is a tight character set — anything outside it is dropped,
// so a malicious "unit" can never carry shell syntax.
function sanitizePath(pth) {
  const p = String(pth || DEFAULT_BLOCKLOG_DB).trim();
  // allow path chars only - anything that could carry shell syntax is dropped
  const cleaned = p.replace(/[^A-Za-z0-9_./@-]/g, '');
  return cleaned || DEFAULT_BLOCKLOG_DB;
}
function sanitizeUnit(unit) {
  const u = String(unit || DEFAULT_BP_UNIT).trim();
  const cleaned = u.replace(/[^A-Za-z0-9_.@-]/g, '');
  return cleaned || DEFAULT_BP_UNIT;
}

// ---- curated queries (Stage 1: one, more added in Stage 2) -----------------
// Each: a label, the unit to target, and a grep applied to journalctl output.
// The grep pattern is a fixed constant (never user input), so it is safe to
// embed. Output is piped through grep -E on the node.
const QUERIES = [
  {
    id: 'errwarn',
    label: 'Errors & warnings',
    hint: 'Warning / Error / Critical severity lines from the block producer (last 24h)',
    unit: () => _cfg.bpUnit,
    grep: '\\((Warning|Error|Critical)',
    sinceHrs: 24,
    okEmpty: 'No warnings or errors in the last 24 hours \u2713',
  },
  {
    id: 'recent',
    label: 'Recent activity',
    hint: 'Latest meaningful log lines (excludes routine local-socket churn)',
    unit: () => _cfg.bpUnit,
    grepOut: 'Net\\.Mux\\.Local|StateQueryServer|LocalHandshake|Forge\\.Loop\\.StartLeadershipCheck|Forge\\.Loop\\.NodeNotLeader|Forge\\.StateInfo\\.StateInfo|Mempool\\.AddedTx',
    tail: 60,
    sinceHrs: 6,
  },
  {
    id: 'kes',
    label: 'KES status',
    hint: 'KES key period / expiry warnings - catch expiry before it costs blocks',
    unit: () => _cfg.bpUnit,
    grep: 'KES info|OperationalCertificate|ExpiryLog',
    sinceHrs: 6,
    tail: 1,
    okEmpty: 'No KES status lines found. If your node logs at Notice level or above, routine KES-info lines may not be present.',
  },
  {
    id: 'restart',
    label: 'Restarts & startup',
    hint: 'Node version banner and startup lines - when and why it last restarted',
    unit: () => _cfg.bpUnit,
    grep: 'Node version|cardano-node [0-9]|Started opening|Chain DB|Byron|Shelley|Conway|Started blockchain',
    sinceHrs: 24 * 14,
  },
  {
    id: 'rollback',
    label: 'Rollbacks',
    hint: 'Chain switches / rollbacks - frequent ones can indicate relay problems',
    unit: () => _cfg.bpUnit,
    grep: 'SwitchedToAFork|Rollback|RolledBack|switched to a fork',
    sinceHrs: 24,
    okEmpty: 'No rollbacks or fork switches in the last 24 hours \u2713',
  },
  {
    id: 'blocks',
    label: 'Blocks minted',
    hint: 'Forged blocks and their on-chain status from the local CNCLI blocklog DB',
    kind: 'blocklog',
  },
  {
    id: 'propagation',
    label: 'Propagation history',
    hint: 'Per-block propagation delay over time, with the slowest blocks surfaced for review',
    kind: 'propagation',
  },
  {
    id: 'epochtx',
    label: 'Epoch transition',
    hint: 'Block production and propagation around epoch / hard-fork boundaries \u2014 shades production gaps and marks the late first block after a gap',
    kind: 'epochtx',
  },
  {
    id: 'leader',
    label: 'Leader slots (CNCLI)',
    hint: 'Scheduled leader slots for this / next epoch from the leaderlog service',
    unit: () => cncliUnit('leaderlog'),
    grep: 'LEADER:|Leaderslots:|Leaderlog calculation',
    sinceHrs: 24 * 7,
    okEmpty: 'No leader-schedule lines in the last 7 days.',
  },
  {
    id: 'validate',
    label: 'Block validation (CNCLI)',
    hint: 'Adopted / confirmed / missed block status from the validate service',
    unit: () => cncliUnit('validate'),
    grep: 'adopted|confirmed|missed|ADOPTED|CONFIRMED|MISSED|GHOSTED|STOLEN',
    sinceHrs: 24 * 7,
    okEmpty: 'No block-validation lines in the last 7 days.',
  },
];

// Derive a CNCLI unit name from the configured BP unit. Guild names them
// "<bp>-cncli-<role>.service", e.g. cnode_bp-cncli-leaderlog.service.
// Blocks minted: read the local CNCLI blocklog SQLite DB (read-only). This is
// the node's own record of forged blocks and their on-chain fate. NOTE: it only
// covers what CNCLI has recorded on THIS node (here epochs 605+), NOT the pool's
// full lifetime history - db-sync holds that.
function blocklogCommand(dbPath, filterProblems) {
  const db = sanitizePath(dbPath);
  const where = filterProblems ? "WHERE status NOT IN ('confirmed','adopted','leader')" : '';
  // one row per block, newest first; tab-separated for clean parsing/display
  const sql = `SELECT epoch, slot_in_epoch, at, status, block, size, substr(hash,1,12) FROM blocklog ${where} ORDER BY slot DESC;`;
  const sqlSummary = "SELECT status, COUNT(*) FROM blocklog GROUP BY status ORDER BY COUNT(*) DESC;";
  // -readonly guarantees we never write; -separator for parse; run both
  return `${NICE} sqlite3 -readonly -separator '\t' ${shTrick(db)} ${shTrick(sqlSummary)} && echo '===ROWS===' && ${NICE} sqlite3 -readonly -separator '\t' ${shTrick(db)} ${shTrick(sql)}`;
}

function cncliUnit(role) {
  const bp = sanitizeUnit(_cfg.bpUnit);
  const stem = bp.replace(/\.service$/, '');
  return `${stem}-cncli-${role}.service`;
}

function buildQueryCommand(q) {
  const base = journalCmd(q.unit(), { sinceHrs: q.sinceHrs || 24, maxLines: q.maxLines || 5000 });
  // q.grep is a constant from QUERIES, not user input -> safe to embed. The grep
  // runs on the node so only matching lines cross the connection.
  const g = q.grep ? ` | grep -E ${shTrick(q.grep)}` : '';
  const gv = q.grepOut ? ` | grep -vE ${shTrick(q.grepOut)}` : '';
  const tail = q.tail ? ` | tail -n ${Math.max(1, Math.min(2000, Number(q.tail)))}` : '';
  return `${base}${g}${gv}${tail} || true`;
}

// single-quote a constant safely for the shell
function shTrick(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ---- rendering -------------------------------------------------------------
const CSS = `
  .lg-wrap { display: flex; flex-direction: column; gap: 10px; padding: 10px; height: 100%; box-sizing: border-box; }
  .lg-config { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: var(--pt-bg-strip); border: 0.5px solid var(--pt-border); border-radius: 7px; padding: 10px 12px; }
  .lg-config label { font: 600 10px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.5px; color: var(--pt-text-muted); }
  .lg-config input { background: var(--pt-bg, #0d1117); border: 1px solid var(--pt-border); border-radius: 6px; color: var(--pt-text-primary); font: 400 11px ui-monospace, monospace; padding: 6px 9px; min-width: 220px; }
  .lg-config .lg-save { background: #1b2430; color: var(--pt-text-secondary); border: 1px solid var(--pt-border); border-radius: 6px; font-size: 11px; padding: 6px 12px; cursor: pointer; }
  .lg-config .lg-save:hover { color: var(--pt-text-primary); }
  .lg-queries { display: flex; flex-wrap: wrap; gap: 8px; }
  .lg-qbtn { background: var(--pt-bg-strip); border: 0.5px solid var(--pt-border); border-radius: 6px; color: var(--pt-text-secondary); cursor: pointer; font: 600 11px ui-monospace, monospace; padding: 8px 12px; text-align: left; transition: border-color 0.12s, color 0.12s; }
  .lg-qbtn:hover { border-color: var(--pt-accent-blue); color: var(--pt-text-primary); }
  .lg-qbtn.on { border-color: var(--pt-accent-blue-bright, #7BB0F5); color: var(--pt-accent-blue-bright, #7BB0F5); }
  .lg-out { flex: 1 1 auto; min-height: 0; background: #0a0d12; border: 0.5px solid var(--pt-border); border-radius: 7px; overflow: auto; }
  .lg-out pre { margin: 0; padding: 12px; font: 400 11px/1.5 ui-monospace, monospace; color: #c8d2de; white-space: pre-wrap; word-break: break-word; }
  .lg-status { font: 400 11px ui-monospace, monospace; color: var(--pt-text-muted); padding: 2px; }
  .lg-out .lg-err { color: var(--pt-status-warn, #f2b84b); }
  .lg-out .lg-empty { color: var(--pt-text-muted); }
  .lg-topbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .lg-copy { background: #1b2430; color: var(--pt-text-secondary); border: 1px solid var(--pt-border); border-radius: 6px; font-size: 11px; padding: 5px 12px; cursor: pointer; }
  .lg-copy:hover { color: var(--pt-text-primary); }
  .lg-demo-note { font: 400 11px ui-monospace, monospace; color: var(--pt-status-warn, #f2b84b); background: rgba(245,158,11,0.10); border: 1px solid rgba(245,158,11,0.35); border-radius: 6px; padding: 8px 12px; }
  .lg-srcbar { display: flex; align-items: center; gap: 8px; padding: 10px 12px 4px; }
  .lg-srclbl { font: 600 10px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.5px; color: var(--pt-text-muted); }
  .lg-srcbtn { background: var(--pt-bg-strip); border: 0.5px solid var(--pt-border); border-radius: 6px; color: var(--pt-text-secondary); cursor: pointer; font: 600 11px ui-monospace, monospace; padding: 5px 11px; }
  .lg-srcbtn:hover { color: var(--pt-text-primary); }
  .lg-srcbtn.on { border-color: var(--pt-accent-blue-bright, #7BB0F5); color: var(--pt-accent-blue-bright, #7BB0F5); }
  .lg-bl-head { padding: 8px 12px 4px; }
  .lg-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .lg-chip { font: 600 11px ui-monospace, monospace; border: 1px solid; border-radius: 20px; padding: 3px 10px; }
  .lg-chip b { font-weight: 700; }
  .lg-bl-note { font: 400 10.5px ui-monospace, monospace; line-height: 1.5; color: var(--pt-text-muted); }
  .lg-bl-table { width: 100%; border-collapse: collapse; font: 400 11px ui-monospace, monospace; }
  .lg-bl-table th { text-align: left; color: var(--pt-text-muted); font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.5px; padding: 8px 10px; position: sticky; top: 0; background: #0a0d12; border-bottom: 1px solid var(--pt-border); }
  .lg-bl-table td { padding: 6px 10px; border-bottom: 0.5px solid rgba(255,255,255,0.05); color: #c8d2de; white-space: nowrap; }
  .lg-bl-table .lg-num, .lg-bl-table th.lg-num { text-align: right; }
  .lg-pp-table td.lg-num, .lg-pp-table th.lg-num { width: 64px; font-variant-numeric: tabular-nums; }
  .lg-bl-table .lg-hash { color: var(--pt-text-muted); }
  .lg-bl-table tr:hover td { background: rgba(255,255,255,0.03); }
  /* propagation window selector */
  .lg-pw-bar { display:flex; align-items:center; gap:5px; padding:8px 12px 2px; }
  .lg-pw-lbl { font:600 9px ui-monospace,monospace; text-transform:uppercase; letter-spacing:.5px; color:var(--pt-text-muted,#6f7d99); margin-right:4px; }
  .lg-pw-btn { background:var(--pt-bg-strip,#161b24); border:0.5px solid var(--pt-border,#2a3340); border-radius:5px; color:var(--pt-text-muted,#97A0B0); cursor:pointer; font:600 10px ui-monospace,monospace; padding:3px 9px; transition:all .12s; }
  .lg-pw-btn:hover { color:var(--pt-text-primary,#e8e8e8); border-color:var(--pt-accent-blue-bright,#7BB0F5); }
  .lg-pw-btn.on { background:var(--pt-accent-blue,#4d7fd6); border-color:var(--pt-accent-blue,#4d7fd6); color:#fff; }
  /* epoch transition view */
  .etx-wrap { padding:6px 12px 12px; }
  .etx-head { font:12px ui-monospace,monospace; color:var(--pt-text-muted,#97A0B0); padding:4px 0 8px; line-height:1.5; }
  .etx-svg { width:100%; height:auto; display:block; background:var(--pt-bg-strip,#0A0E15); border:0.5px solid var(--pt-border,#2a3340); border-radius:6px; }
  .etx-gaplbl { fill:var(--pt-status-warn,#F59E0B); font:700 11px ui-monospace,monospace; }
  .etx-annlbl { fill:var(--pt-text-primary,#F2F5F9); font:600 10px ui-monospace,monospace; }
  .etx-axis { fill:var(--pt-text-muted,#97A0B0); font:10px ui-monospace,monospace; }
  .etx-legend { display:flex; align-items:center; gap:14px; padding:8px 2px 2px; font:11px ui-monospace,monospace; color:var(--pt-text-secondary,#C4CCD8); }
  .etx-legend i { display:inline-block; width:11px; height:11px; border-radius:2px; margin-right:5px; vertical-align:-1px; }
  .etx-gapnote { color:var(--pt-status-warn,#F59E0B); }
  .etx-summary { padding:8px 2px 0; font:11px ui-monospace,monospace; color:var(--pt-text-muted,#97A0B0); }
  .lg-pp-chartwrap { padding: 6px 12px 10px; }
  .lg-pp-spark { width: 100%; height: 90px; display: block; }
  .lg-pp-ref { stroke: rgba(123,176,245,0.35); stroke-width: 0.6; stroke-dasharray: 4 3; }
  .lg-pp-ref5 { stroke: rgba(255,107,107,0.4); stroke-width: 0.6; stroke-dasharray: 4 3; }
  .lg-pp-axis { display: flex; justify-content: space-between; font: 400 9.5px ui-monospace, monospace; color: var(--pt-text-muted); margin-top: 2px; }
  .lg-pp-subhead { font: 600 10px ui-monospace, monospace; text-transform: uppercase; letter-spacing: 0.5px; color: var(--pt-accent-blue-bright, #7BB0F5); padding: 8px 12px 4px; }
  .lg-pp-table { }
`;

let _lastOutput = '';

export function mountLogs(canvas) {
  _cfg = loadCfg();
  if (!_cfg.bpUnit) _cfg.bpUnit = DEFAULT_BP_UNIT;
  if (!_cfg.blocklogDb) _cfg.blocklogDb = DEFAULT_BLOCKLOG_DB;

  const demo = (getMode() === 'demo');

  canvas.innerHTML = `
    <style>${CSS}</style>
    <div class="lg-wrap">
      ${demo ? '<div class="lg-demo-note">Demonstration mode - connect to a node to query live logs. Sample output shown below.</div>' : ''}
      <div class="lg-config">
        <label for="lg-unit">BP journal unit</label>
        <input id="lg-unit" type="text" spellcheck="false" autocomplete="off" value="${escAttr(_cfg.bpUnit)}">
        <label for="lg-db">Blocklog DB</label>
        <input id="lg-db" type="text" spellcheck="false" autocomplete="off" value="${escAttr(_cfg.blocklogDb)}" style="min-width:320px">
        <button class="lg-save" id="lg-save" type="button">Save</button>
        <span class="lg-status" id="lg-cfg-status"></span>
      </div>
      <div class="lg-queries" id="lg-queries">
        ${QUERIES.map((q) => `<button class="lg-qbtn" type="button" data-q="${q.id}" title="${escAttr(q.hint)}">${escHtml(q.label)}</button>`).join('')}
      </div>
      <div class="lg-topbar">
        <span class="lg-status" id="lg-status">Pick a query above.</span>
        <button class="lg-copy" id="lg-copy" type="button">Copy output</button>
      </div>
      <div class="lg-out" id="lg-out"><pre class="lg-empty">No query run yet.</pre></div>
    </div>
  `;

  // save unit
  const unitInput = canvas.querySelector('#lg-unit');
  const dbInput = canvas.querySelector('#lg-db');
  canvas.querySelector('#lg-save').addEventListener('click', () => {
    _cfg.bpUnit = sanitizeUnit(unitInput.value);
    unitInput.value = _cfg.bpUnit;
    if (dbInput) { _cfg.blocklogDb = sanitizePath(dbInput.value); dbInput.value = _cfg.blocklogDb; }
    saveCfg(_cfg);
    setStatus('#lg-cfg-status', 'Saved.');
    setTimeout(() => setStatus('#lg-cfg-status', ''), 1500);
  });

  // run a query on click
  canvas.querySelectorAll('.lg-qbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      canvas.querySelectorAll('.lg-qbtn').forEach((b) => b.classList.toggle('on', b === btn));
      const q = QUERIES.find((x) => x.id === btn.dataset.q);
      if (q) runQuery(canvas, q, demo);
    });
  });

  // copy output
  canvas.querySelector('#lg-copy').addEventListener('click', () => {
    if (!_lastOutput) return;
    try { navigator.clipboard.writeText(_lastOutput); } catch { /* ignore */ }
    setStatus('#lg-status', 'Copied.');
  });

  // If we arrived here from a deep-link (e.g. the dashboard "See history"
  // button), auto-run that query and highlight its button.
  try {
    const want = window.__ptOpenLogsQuery;
    if (want) {
      window.__ptOpenLogsQuery = null;
      const btn = canvas.querySelector(`.lg-qbtn[data-q="${want}"]`);
      if (btn) btn.click();
    }
  } catch (e) { /* non-critical */ }
}

// --- Propagation history ----------------------------------------------------
async function runPropagation(canvas, q, demo) {
  const out = canvas.querySelector('#lg-out');
  out.innerHTML = '<pre class="lg-empty">Loading propagation history…</pre>';

  if (demo) {
    const now = Date.now();
    const series = Array.from({ length: 60 }, (_, i) => ({ t: Math.floor((now - (60 - i) * 20000) / 1000), v: 0.2 + Math.random() * 0.9 }));
    series[42].v = 7.7;
    const stats = { count: 60, min: 0.21, max: 7.7, mean: 0.74, median: 0.62, p95: 1.3, over1: 4, over2: 1, over5: 1 };
    const slow = [{ ts: now - 800000, delay: 7.7, cdf1: 0.62, cdf3: 0.9, cdf5: 0.98 }];
    out.innerHTML = renderPropWindowBar() + renderPropagation({ series, slow, stats });
    wirePropWindowBar(canvas, q, demo);
    setStatus('#lg-status', 'Propagation history - demonstration data');
    return;
  }

  try {
    const win = PROP_WINDOWS.find((w) => w.id === _propWindow) || PROP_WINDOWS[2];
    const sinceTs = win.ms == null ? 0 : Math.floor((Date.now() - win.ms) / 1000);
    const data = await getPropagationHistory(sinceTs);
    if (!data.series || !data.series.length) {
      out.innerHTML = renderPropWindowBar() +
        `<pre class="lg-empty">No propagation data in the last ${win.label === 'All' ? 'history' : win.label}. ` +
        `Data builds up as blocks arrive while the app is connected - try a wider window or check back later.</pre>`;
      wirePropWindowBar(canvas, q, demo);
      setStatus('#lg-status', `Propagation history - no data in ${win.label}`);
      return;
    }
    _lastOutput = data.series.map((x) => `${new Date(x.t * 1000).toISOString()}\t${x.v}`).join('\n');
    out.innerHTML = renderPropWindowBar() + renderPropagation(data);
    wirePropWindowBar(canvas, q, demo);
    setStatus('#lg-status', `Propagation history (${win.label}) - ${data.series.length} blocks`);
  } catch (e) {
    out.innerHTML = `<pre class="lg-err">Could not load propagation history: ${escHtml(e.message || String(e))}</pre>`;
    setStatus('#lg-status', 'Propagation history - failed');
  }
}

// The window selector bar (1h / 6h / 24h / 7d / All)
function renderPropWindowBar() {
  const btns = PROP_WINDOWS.map((w) =>
    `<button class="lg-pw-btn${w.id === _propWindow ? ' on' : ''}" data-pw="${w.id}">${w.label}</button>`
  ).join('');
  return `<div class="lg-pw-bar"><span class="lg-pw-lbl">Window</span>${btns}</div>`;
}
function wirePropWindowBar(canvas, q, demo) {
  canvas.querySelectorAll('.lg-pw-btn[data-pw]').forEach((b) => {
    b.addEventListener('click', () => {
      _propWindow = b.getAttribute('data-pw');
      runPropagation(canvas, q, demo);   // re-run with the new window
    });
  });
}

function fmtDelay(v) {
  const n = Number(v);
  return (n >= 10 ? n.toFixed(1) : n.toFixed(2)) + 's';
}
function delayColor(v) {
  if (v >= 5) return 'var(--pt-status-bad, #ff6b6b)';
  if (v >= 2) return 'var(--pt-status-warn, #f2b84b)';
  if (v >= 1) return 'var(--pt-accent-blue-bright, #7BB0F5)';
  return 'var(--pt-status-good, #5dff9b)';
}

function renderPropagation(data) {
  const { series, slow, stats } = data;
  // sparkline (SVG) of the series, capped height, slow points marked
  const W = 640, H = 90, pad = 4;
  const vals = series.map((x) => x.v);
  const maxV = Math.max(2, Math.max(...vals));
  const stepX = (W - pad * 2) / Math.max(1, series.length - 1);
  const pts = series.map((x, i) => {
    const px = pad + i * stepX;
    const py = H - pad - (x.v / maxV) * (H - pad * 2);
    return `${px.toFixed(1)},${py.toFixed(1)}`;
  }).join(' ');
  const dots = series.map((x, i) => {
    if (x.v < 2) return '';
    const px = pad + i * stepX;
    const py = H - pad - (x.v / maxV) * (H - pad * 2);
    return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.5" fill="${delayColor(x.v)}"/>`;
  }).join('');
  // 1s and 5s reference lines
  const y1 = H - pad - (1 / maxV) * (H - pad * 2);
  const y5 = H - pad - (5 / maxV) * (H - pad * 2);
  const chart = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="lg-pp-spark">
    <line x1="0" y1="${y1.toFixed(1)}" x2="${W}" y2="${y1.toFixed(1)}" class="lg-pp-ref"/>
    ${5 <= maxV ? `<line x1="0" y1="${y5.toFixed(1)}" x2="${W}" y2="${y5.toFixed(1)}" class="lg-pp-ref5"/>` : ''}
    <polyline points="${pts}" fill="none" stroke="var(--pt-accent-blue, #4d7fd6)" stroke-width="1.2"/>
    ${dots}
  </svg>`;

  const S = stats || {};
  const chips = `
    <span class="lg-chip" style="color:${delayColor(S.median)};border-color:${delayColor(S.median)}">median <b>${fmtDelay(S.median)}</b></span>
    <span class="lg-chip" style="color:${delayColor(S.p95)};border-color:${delayColor(S.p95)}">p95 <b>${fmtDelay(S.p95)}</b></span>
    <span class="lg-chip" style="color:${delayColor(S.max)};border-color:${delayColor(S.max)}">worst <b>${fmtDelay(S.max)}</b></span>
    <span class="lg-chip" style="color:var(--pt-status-warn);border-color:var(--pt-status-warn)">&ge;2s <b>${S.over2 || 0}</b></span>
    <span class="lg-chip" style="color:var(--pt-status-bad);border-color:var(--pt-status-bad)">&ge;5s <b>${S.over5 || 0}</b></span>
    <span class="lg-chip" style="color:var(--pt-text-muted);border-color:var(--pt-text-muted)">${S.count || 0} blocks</span>`;

  const slowRows = (slow && slow.length)
    ? slow.map((r) => {
        const when = new Date(r.ts).toISOString().replace('T', ' ').replace(/\..*/, ' UTC');
        return `<tr>
          <td>${escHtml(when)}</td>
          <td style="color:${delayColor(r.delay)};font-weight:600">${fmtDelay(r.delay)}</td>
          <td class="lg-num">${r.cdf1 != null ? (r.cdf1 * 100).toFixed(1) + '%' : '-'}</td>
          <td class="lg-num">${r.cdf3 != null ? (r.cdf3 * 100).toFixed(1) + '%' : '-'}</td>
          <td class="lg-num">${r.cdf5 != null ? (r.cdf5 * 100).toFixed(1) + '%' : '-'}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="5" class="lg-empty" style="padding:10px">No slow blocks (over 2s) recorded - propagation has been healthy.</td></tr>';

  return `
    <div class="lg-bl-head">
      <div class="lg-chips">${chips}</div>
      <div class="lg-bl-note">Per-block propagation delay captured live and kept in the local cache. Delay is how long after a block's slot your node saw it - lower is better. Slow blocks (over 2s) are logged below for review. Data persists across restarts and builds up over time.</div>
    </div>
    <div class="lg-pp-chartwrap">${chart}
      <div class="lg-pp-axis"><span>oldest</span><span class="lg-pp-ref-lbl">— 1s &nbsp; ⋯ 5s</span><span>newest</span></div>
    </div>
    <div class="lg-pp-subhead">Slowest blocks (worst first)</div>
    <table class="lg-bl-table lg-pp-table">
      <thead><tr><th>time</th><th>delay</th><th class="lg-num">&lt;1s</th><th class="lg-num">&lt;3s</th><th class="lg-num">&lt;5s</th></tr></thead>
      <tbody>${slowRows}</tbody>
    </table>`;
}

// --- Blocks minted (CNCLI blocklog DB) --------------------------------------
const STATUS_STYLE = {
  confirmed: { c: 'var(--pt-status-good, #5dff9b)', t: 'confirmed' },
  adopted:   { c: 'var(--pt-accent-blue-bright, #7BB0F5)', t: 'adopted' },
  leader:    { c: 'var(--pt-text-secondary, #C4CCD8)', t: 'leader (scheduled)' },
  missed:    { c: 'var(--pt-status-bad, #ff6b6b)', t: 'missed' },
  ghosted:   { c: 'var(--pt-status-warn, #f2b84b)', t: 'ghosted' },
  stolen:    { c: 'var(--pt-status-warn, #f2b84b)', t: 'stolen' },
};

let _blocksSource = null;   // 'local' | 'dbsync' (chosen per session)

async function runBlocklog(canvas, q, demo) {
  const out = canvas.querySelector('#lg-out');
  const dbsyncAvail = (() => { try { return demo || dbsyncMachine() != null; } catch { return false; } })();
  // default: db-sync (full lifetime history) when available, else local blocklog
  if (_blocksSource == null) _blocksSource = dbsyncAvail ? 'dbsync' : 'local';

  const toggle = dbsyncAvail ? `
    <div class="lg-srcbar">
      <span class="lg-srclbl">Source:</span>
      <button class="lg-srcbtn ${_blocksSource === 'dbsync' ? 'on' : ''}" data-bsrc="dbsync" type="button">Full history (db-sync)</button>
      <button class="lg-srcbtn ${_blocksSource === 'local' ? 'on' : ''}" data-bsrc="local" type="button">Local (CNCLI, with status)</button>
    </div>` : '';

  out.innerHTML = `${toggle}<div id="lg-bl-inner"><pre class="lg-empty">Loading block history…</pre></div>`;
  // wire the toggle
  out.querySelectorAll('.lg-srcbtn').forEach((b) => {
    b.addEventListener('click', () => { _blocksSource = b.dataset.bsrc; runBlocklog(canvas, q, demo); });
  });
  const inner = out.querySelector('#lg-bl-inner');

  if (_blocksSource === 'dbsync') {
    return loadDbsyncBlocks(inner, demo);
  }
  return loadLocalBlocks(inner, demo);
}

async function loadDbsyncBlocks(inner, demo) {
  if (demo) {
    const rows = [
      ['643','296123','2026-07-17T08:00:14+00:00','onchain','13689109','4340','518994488363'],
      ['640','354715','2026-07-03T00:16:46+00:00','onchain','13627716','4','0a4513855591'],
    ];
    inner.innerHTML = renderBlocklog([['onchain','334']], rows, true);
    setStatus('#lg-status', 'Blocks minted (db-sync) - demonstration data');
    return;
  }
  try {
    const blocks = await getBlockHistory(100000);
    _lastOutput = blocks.map((b) => `${b.epoch}\t${b.slotInEpoch}\t${b.at}\t${b.status}\t${b.block}\t${b.size}\t${b.hash}`).join('\n');
    if (!blocks.length) {
      inner.innerHTML = '<pre class="lg-empty">No blocks returned from db-sync for this pool.</pre>';
      setStatus('#lg-status', 'Blocks minted (db-sync) - none');
      return;
    }
    const rows = blocks.map((b) => [String(b.epoch), String(b.slotInEpoch), b.at, b.status, String(b.block), String(b.size), b.hash]);
    inner.innerHTML = renderBlocklog([['onchain', String(blocks.length)]], rows, true);
    setStatus('#lg-status', `Blocks minted (db-sync) - ${blocks.length} lifetime blocks`);
  } catch (e) {
    inner.innerHTML = `<pre class="lg-err">db-sync block history failed: ${escHtml(e.message || String(e))}\n\nThis needs db-sync connected. Switch to the Local (CNCLI) source above to read the on-node blocklog instead.</pre>`;
    setStatus('#lg-status', 'Blocks minted (db-sync) - failed');
  }
}

async function loadLocalBlocks(inner, demo) {
  if (demo) {
    inner.innerHTML = renderBlocklog(
      [['confirmed','28'],['ghosted','1']],
      [['642','100122','2026-07-10T01:33:33+00:00','confirmed','13657913','1004','9c1faa22bb01'],
       ['640','354715','2026-07-03T00:16:46+00:00','confirmed','13627716','870','3f2ade90aa17']], false);
    setStatus('#lg-status', 'Blocks minted (local) - demonstration data');
    return;
  }
  try {
    const cmd = blocklogCommand(_cfg.blocklogDb, false);
    const text = await runCmd(cmd);
    const [sumPart, rowPart] = String(text).split('===ROWS===');
    const summary = (sumPart || '').trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
    const rows = (rowPart || '').trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
    _lastOutput = text || '';
    if (!rows.length) {
      inner.innerHTML = '<pre class="lg-empty">No blocks found in the blocklog DB. Check the DB path in the config above.</pre>';
      setStatus('#lg-status', 'Blocks minted (local) - none found');
      return;
    }
    inner.innerHTML = renderBlocklog(summary, rows, false);
    setStatus('#lg-status', `Blocks minted (local) - ${rows.length} recorded`);
  } catch (e) {
    inner.innerHTML = `<pre class="lg-err">Could not read the blocklog DB: ${escHtml(e.message || String(e))}\n\nExpected a readable SQLite file at:\n${escHtml(_cfg.blocklogDb)}</pre>`;
    setStatus('#lg-status', 'Blocks minted (local) - failed');
  }
}

function renderBlocklog(summary, rows, isDbsync) {
  // honest provenance line: this DB is NOT full lifetime history
  const epochs = rows.map((r) => parseInt(r[0], 10)).filter((n) => !isNaN(n));
  const minE = epochs.length ? Math.min(...epochs) : null;
  const maxE = epochs.length ? Math.max(...epochs) : null;
  const range = (minE != null) ? `epochs ${minE}\u2013${maxE}` : '';

  const chips = summary.map(([st, n]) => {
    const s = STATUS_STYLE[st] || { c: 'var(--pt-text-muted)', t: st };
    return `<span class="lg-chip" style="color:${s.c};border-color:${s.c}">${escHtml(s.t)}: <b>${escHtml(n)}</b></span>`;
  }).join('');

  const body = rows.map((r) => {
    const [epoch, sie, at, status, block, size, hash] = r;
    const s = STATUS_STYLE[status] || { c: 'var(--pt-text-muted)', t: status };
    const when = (at || '').replace('T', ' ').replace(/\+00:00$/, ' UTC');
    return `<tr>
      <td>${escHtml(epoch)}</td>
      <td class="lg-num">${escHtml(sie)}</td>
      <td>${escHtml(when)}</td>
      <td style="color:${s.c};font-weight:600">${escHtml(s.t)}</td>
      <td class="lg-num">${escHtml(block || '')}</td>
      <td class="lg-num">${escHtml(size || '')}</td>
      <td class="lg-hash">${escHtml(hash || '')}</td>
    </tr>`;
  }).join('');

  const note = isDbsync
    ? `Full lifetime history from db-sync${range ? ` (${range})` : ''} - every block this pool has forged on-chain. db-sync records only blocks that made the chain, so it has no ghosted/stolen status; for that (recent blocks) switch to the Local CNCLI source.`
    : `From the local CNCLI blocklog on this node${range ? ` (${range})` : ''}. This is recent blocks with their fate (confirmed / ghosted / stolen), not full lifetime history. For the complete record switch to the db-sync source.`;
  return `
    <div class="lg-bl-head">
      <div class="lg-chips">${chips}</div>
      <div class="lg-bl-note">${note}</div>
    </div>
    <table class="lg-bl-table">
      <thead><tr><th>epoch</th><th class="lg-num">slot-in-epoch</th><th>time</th><th>status</th><th class="lg-num">block #</th><th class="lg-num">size</th><th>hash</th></tr></thead>
      <tbody>${body}</tbody>
    </table>`;
}

async function runQuery(canvas, q, demo) {
  const out = canvas.querySelector('#lg-out');
  setStatus('#lg-status', `Running: ${q.label}…`);

  if (q.kind === 'blocklog') { return runBlocklog(canvas, q, demo); }
  if (q.kind === 'epochtx') { return runEpochTransition(canvas, q, demo); }
  if (q.kind === 'propagation') { return runPropagation(canvas, q, demo); }

  out.innerHTML = '<pre class="lg-empty">Querying the journal…</pre>';

  if (demo) {
    const sample = demoSample(q.id);
    _lastOutput = sample;
    out.innerHTML = `<pre>${escHtml(sample)}</pre>`;
    setStatus('#lg-status', `${q.label} - demonstration data`);
    return;
  }

  try {
    const cmd = buildQueryCommand(q);
    const text = await runCmd(cmd);
    _lastOutput = text || '';
    if (!text || !text.trim()) {
      const msg = q.okEmpty || 'No matching log lines in the queried window.';
      out.innerHTML = `<pre class="lg-empty">${escHtml(msg)}</pre>`;
      setStatus('#lg-status', `${q.label} - no matches`);
    } else {
      out.innerHTML = `<pre>${escHtml(text)}</pre>`;
      const n = text.trim().split('\n').length;
      setStatus('#lg-status', `${q.label} - ${n} line${n === 1 ? '' : 's'}`);
    }
  } catch (e) {
    out.innerHTML = `<pre class="lg-err">Query failed: ${escHtml(e.message || String(e))}\n\nIf this is a permissions error, the SSH user may need to be in the 'systemd-journal' group to read this unit's logs.</pre>`;
    setStatus('#lg-status', `${q.label} - failed`);
  }
}

function setStatus(sel, txt) {
  const el = document.querySelector(sel);
  if (el) el.textContent = txt;
}

export function unmountLogs() { /* nothing persistent to tear down */ }

// ---- helpers ---------------------------------------------------------------
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escAttr(s) {
  return escHtml(s).replace(/"/g, '&quot;');
}

function demoSample(id) {
  const D = {
    errwarn: [
      'Jul 16 03:14:22 demo-bp cnode_bp[565905]: [..][demo:ChainDB](Warning,12) Chain extended, new tip 3f2a... at slot 192600001',
      'Jul 15 22:04:03 demo-bp cnode_bp[565905]: [..][demo:KESInfo](Warning,7) Operational certificate KES period 512 - 12 periods until expiry',
    ],
    recent: [
      'Jul 17 08:00:14 demo-bp cnode_bp[565905]: [..][demo:Forge.AdoptedBlock](Info) Adopted block, slot 192708923',
      'Jul 17 07:58:02 demo-bp cnode_bp[565905]: [..][demo:ChainDB.AddBlock](Info) Added block to current chain, tip slot 192708700',
    ],
    kes: [
      'Jul 15 22:04:03 demo-bp cnode_bp[565905]: [..][demo:KESInfo](Warning,7) KES period 512 - 12 periods until expiry (approx 2026-09-02)',
    ],
    restart: [
      'Jul 10 09:12:44 demo-bp cnode_bp[561200]: [..] Node version: cardano-node 11.0.1 - linux',
      'Jul 10 09:12:46 demo-bp cnode_bp[561200]: [..][demo:ChainDB] Started opening Chain DB',
    ],
    rollback: [],
    leader: [
      'Jul 12 09:46:32 demo-bp cnode_bp-cncli-leaderlog[40876]: LEADER: slot[192708923] slotInEpoch[296123] at[2026-07-17T08:00:14+00:00]',
      'Jul 12 09:46:32 demo-bp cnode_bp-cncli-leaderlog[40876]: Leaderslots: 3 - Ideal slots for epoch based on active stake: 0.62 - Luck factor 483.87%',
    ],
    validate: [
      'Jul 17 08:00:40 demo-bp cnode_bp-cncli-validate[41022]: Block validation: slot[192708923] status[adopted]',
    ],
  };
  const lines = D[id];
  if (!lines) return '(demonstration data)';
  if (lines.length === 0) return '';
  return lines.join('\n');
}


// ---- Epoch / hard-fork transition view ------------------------------------
// Renders the propagation series around a boundary the way the fork chart does:
// stems per block coloured by delay, PRODUCTION GAPS shaded and labelled, and
// the boundary marked. A "gap" is a jump between consecutive real blocks far
// larger than the normal ~20s spacing (each series point is one real block now
// that capture dedups on block number).
const ETX_NORMAL_GAP_S = 20;          // nominal slot/block spacing
const ETX_GAP_FACTOR   = 6;           // >6x nominal (~2 min) counts as a gap
const ETX_SLOW_S       = 2;           // amber threshold
const ETX_VSLOW_S      = 5;           // red threshold

async function runEpochTransition(canvas, q, demo) {
  const out = canvas.querySelector('#lg-output');
  setStatus('#lg-status', 'Epoch transition - loading');
  try {
    // Reuse the same windowed history the propagation view uses.
    const win = PROP_WINDOWS.find((w) => w.id === _propWindow) || PROP_WINDOWS[3];
    const sinceTs = win.ms == null ? 0 : Math.floor((Date.now() - win.ms) / 1000);
    const data = await getPropagationHistory(sinceTs);
    const series = (data && data.series) || [];
    if (series.length < 2) {
      out.innerHTML = renderPropWindowBar() +
        '<pre class="lg-empty">Not enough block history in this window to show a transition. Widen the window or check back after more blocks.</pre>';
      wireEtxWindowBar(canvas, q, demo);
      setStatus('#lg-status', 'Epoch transition - no data');
      return;
    }
    const gaps = detectGaps(series);
    out.innerHTML = renderPropWindowBar() + renderEpochTransition(series, gaps);
    wireEtxWindowBar(canvas, q, demo);
    const gtxt = gaps.length ? `${gaps.length} gap${gaps.length>1?'s':''} detected` : 'no gaps';
    setStatus('#lg-status', `Epoch transition (${win.label}) - ${series.length} blocks, ${gtxt}`);
  } catch (e) {
    out.innerHTML = `<pre class="lg-err">Could not load epoch transition: ${escHtml(e.message || String(e))}</pre>`;
    setStatus('#lg-status', 'Epoch transition - failed');
  }
}

function wireEtxWindowBar(canvas, q, demo) {
  canvas.querySelectorAll('.lg-pw-btn[data-pw]').forEach((b) => {
    b.addEventListener('click', () => {
      _propWindow = b.getAttribute('data-pw');
      runEpochTransition(canvas, q, demo);
    });
  });
}

// Find stretches where consecutive blocks are spaced far wider than normal.
function detectGaps(series) {
  const out = [];
  const thresh = ETX_NORMAL_GAP_S * ETX_GAP_FACTOR;
  for (let i = 1; i < series.length; i++) {
    const dt = series[i].t - series[i - 1].t;   // seconds
    if (dt >= thresh) {
      out.push({ from: series[i - 1].t, to: series[i].t, secs: dt, afterIdx: i });
    }
  }
  return out;
}

function fmtClock(ts) {
  const d = new Date(ts * 1000);
  return d.toISOString().slice(11, 19) + 'Z';
}
function fmtDur(secs) {
  if (secs >= 60) return `${(secs / 60).toFixed(1)} min`;
  return `${Math.round(secs)}s`;
}

function renderEpochTransition(series, gaps) {
  const W = 1100, H = 300, padL = 44, padR = 16, padT = 18, padB = 34;
  const t0 = series[0].t, t1 = series[series.length - 1].t;
  const span = Math.max(1, t1 - t0);
  const maxV = Math.max(ETX_VSLOW_S + 1, ...series.map((s) => s.v));
  const x = (t) => padL + ((t - t0) / span) * (W - padL - padR);
  const y = (v) => (H - padB) - (v / maxV) * (H - padT - padB);

  const col = (v) => v >= ETX_VSLOW_S ? 'var(--pt-status-bad,#EF4444)'
                    : v >= ETX_SLOW_S ? 'var(--pt-status-warn,#F59E0B)'
                    : 'var(--pt-status-good,#10B981)';

  // gap shading + labels
  let gapSvg = '';
  for (const g of gaps) {
    const gx0 = x(g.from), gx1 = x(g.to);
    gapSvg += `<rect x="${gx0.toFixed(1)}" y="${padT}" width="${(gx1-gx0).toFixed(1)}" height="${H-padT-padB}" fill="var(--pt-status-warn,#F59E0B)" opacity="0.10"/>`;
    gapSvg += `<line x1="${gx0.toFixed(1)}" y1="${padT}" x2="${gx0.toFixed(1)}" y2="${H-padB}" stroke="var(--pt-status-warn,#F59E0B)" stroke-width="1" stroke-dasharray="3,3" opacity="0.7"/>`;
    gapSvg += `<line x1="${gx1.toFixed(1)}" y1="${padT}" x2="${gx1.toFixed(1)}" y2="${H-padB}" stroke="var(--pt-status-warn,#F59E0B)" stroke-width="1" stroke-dasharray="3,3" opacity="0.7"/>`;
    const mid = (gx0 + gx1) / 2;
    gapSvg += `<text x="${mid.toFixed(1)}" y="${padT+16}" text-anchor="middle" class="etx-gaplbl">${fmtDur(g.secs)} — no blocks</text>`;
  }

  // stems
  let stems = '';
  for (const s of series) {
    const sx = x(s.t), sy = y(s.v), by = y(0);
    stems += `<line x1="${sx.toFixed(1)}" y1="${by.toFixed(1)}" x2="${sx.toFixed(1)}" y2="${sy.toFixed(1)}" stroke="${col(s.v)}" stroke-width="1.5" opacity="0.85"/>`;
    stems += `<circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="2.6" fill="${col(s.v)}"/>`;
  }

  // annotate the worst block after the largest gap (the "late transition block")
  let ann = '';
  if (gaps.length) {
    const biggest = gaps.slice().sort((a,b)=>b.secs-a.secs)[0];
    // find worst-delay block within ~90s after the gap ends
    const after = series.filter((s) => s.t >= biggest.to && s.t <= biggest.to + 90);
    if (after.length) {
      const worst = after.slice().sort((a,b)=>b.v-a.v)[0];
      const ax = x(worst.t), ay = y(worst.v);
      ann += `<circle cx="${ax.toFixed(1)}" cy="${ay.toFixed(1)}" r="5" fill="none" stroke="var(--pt-status-bad,#EF4444)" stroke-width="1.6"/>`;
      const lx = Math.min(ax + 8, W - 210);
      ann += `<text x="${lx.toFixed(1)}" y="${(ay-8).toFixed(1)}" class="etx-annlbl">first block after gap: ${worst.v.toFixed(1)}s late</text>`;
    }
  }

  // y gridlines at 0/slow/vslow
  const grid = [0, ETX_SLOW_S, ETX_VSLOW_S].map((v) =>
    `<line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W-padR}" y2="${y(v).toFixed(1)}" stroke="var(--pt-border,#2a3340)" stroke-width="0.5" opacity="0.5"/>`
    + `<text x="${padL-6}" y="${(y(v)+3).toFixed(1)}" text-anchor="end" class="etx-axis">${v}s</text>`
  ).join('');

  // x end labels
  const xlabels = `<text x="${padL}" y="${H-10}" class="etx-axis">${fmtClock(t0)}</text>`
                + `<text x="${W-padR}" y="${H-10}" text-anchor="end" class="etx-axis">${fmtClock(t1)}</text>`;

  const gapSummary = gaps.length
    ? gaps.map((g) => `${fmtClock(g.from)} \u2192 ${fmtClock(g.to)} (${fmtDur(g.secs)})`).join(' \u00b7 ')
    : 'No production gaps in this window \u2014 steady block flow.';

  return `
    <div class="etx-wrap">
      <div class="etx-head">Epoch / transition view \u2014 block production and propagation. Gaps (no blocks) are shaded; stems are per-block delay.</div>
      <svg viewBox="0 0 ${W} ${H}" class="etx-svg" preserveAspectRatio="xMidYMid meet">
        ${grid}${gapSvg}${stems}${ann}${xlabels}
      </svg>
      <div class="etx-legend">
        <span><i style="background:var(--pt-status-good,#10B981)"></i>&lt;2s</span>
        <span><i style="background:var(--pt-status-warn,#F59E0B)"></i>2\u20135s</span>
        <span><i style="background:var(--pt-status-bad,#EF4444)"></i>&gt;5s</span>
        <span class="etx-gapnote">Shaded = production gap</span>
      </div>
      <div class="etx-summary">${gapSummary}</div>
    </div>`;
}
