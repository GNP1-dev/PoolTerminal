/**
 * PoolTerminal - first-run SETUP WIZARD (Pass 1: shell + light steps).
 *
 * A guided, one-decision-per-screen walkthrough shown on first run (no saved
 * config) and re-runnable anytime from ⚙ Settings → "Run setup again".
 *
 * Design rules (deliberate - this is the first thing a new operator sees):
 *   • One clear decision per step, plain language, no unexplained jargon.
 *   • Every choice says where to change it later (nothing is a dead end).
 *   • Optional inputs say plainly when to include vs skip them.
 *
 * Pass 1 builds the frame (progress, Back/Next, wording) and the light steps:
 * Welcome, Run-location, and Done (with hard-fork / upgrade awareness). The
 * heavy steps - Connect, Data source (+ db-sync credentials, Blockfrost
 * placeholder), Notifications - are walkable placeholders here and get wired in
 * Pass 2.
 *
 * Reuses the .pt-modal shell and the WebKitGTK-safe select treatment from the
 * connect/settings dialogs.
 */

import { DBSYNC_TESTED_SCHEMA as schemaTested, initDbsync } from '../data/dbsync-query.js';
import { suggestPollMs, pollUsage, fmtInterval, POLL_LADDER_MS, getNotifSettings, saveNotifSettings } from '../data/notif-settings.js';
import { showConnectModal } from './connect.js';
import { applyBlockfrostKey } from '../data/read-model.js';

const APP_VERSION = '0.1.0';   // keep in step with package.json

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── wizard state (accumulates choices; applied on Finish in Pass 2) ──────────
function freshState() {
  return {
    transport: null,        // 'ssh' | 'local'
    conn: {},               // host/port/user/env/auth
    useDbsync: false,       // optional db-sync
    dbsync: {},             // db-sync DB creds
    useBlockfrost: false,   // optional Blockfrost
    blockfrostKey: '',      // Blockfrost project key
    notif: {},              // poll cadence + threshold
  };
}

// ── steps ────────────────────────────────────────────────────────────────────
// Each: { key, title, render(wiz)->html, collect?(wiz,root), validate?(wiz,root)->err|null }
const STEPS = [
  {
    key: 'welcome',
    title: 'Welcome to PoolTerminal',
    render: () => `
      <p class="wz-lead">PoolTerminal is a live dashboard for your Cardano stake pool - block production,
      delegators, node health and on-chain notifications, all in one place.</p>
      <p class="wz-p">This quick setup takes about two minutes. It asks where your node runs, how to
      connect to it, and where to read data from.</p>
      <div class="wz-note">You can change any of these answers later from the
      <strong>⚙ Settings</strong> button in the top-right, so don't worry about getting everything
      perfect now.</div>`,
  },
  {
    key: 'transport',
    title: 'Where does PoolTerminal run?',
    render: (wiz) => `
      <p class="wz-p">Pick where this app is running, relative to your Cardano node.</p>
      <div class="wz-cards">
        <button class="wz-card ${wiz.transport === 'ssh' ? 'wz-card-on' : ''}" data-choice="ssh" type="button">
          <div class="wz-card-h">On a different machine</div>
          <div class="wz-card-d">PoolTerminal connects to your node over SSH. This is the usual choice -
          e.g. the app on your laptop, the node on a server.</div>
          <div class="wz-card-w">Choose this if the node is on another box.</div>
        </button>
        <button class="wz-card ${wiz.transport === 'local' ? 'wz-card-on' : ''}" data-choice="local" type="button">
          <div class="wz-card-h">On the node itself</div>
          <div class="wz-card-d">PoolTerminal runs commands locally - no SSH or password needed.</div>
          <div class="wz-card-w">Choose this only if you're running the app directly on the node machine.</div>
        </button>
      </div>
      <div class="wz-foot">Change later: ⚙ Settings, or the connection screen (click the LIVE badge).</div>`,
    validate: (wiz) => (wiz.transport ? null : 'Please choose where PoolTerminal is running.'),
  },
  {
    key: 'connect',
    title: 'Connect to your node',
    render: (wiz) => wiz._connected
      ? `<div class="wz-ok">Connected to your node \u2713</div>
         <p class="wz-p">PoolTerminal is now reading live data. Continue to choose where pool data comes from.</p>
         <div class="wz-foot">Need to change it? Reconnect anytime from the LIVE badge, top-right.</div>`
      : `<p class="wz-p">Next, open the connection screen to reach your node. You'll enter the host, port,
         username and your node's env file path.</p>
         <p class="wz-p">Your SSH password and 2FA code are never saved - they're used only to open the
         connection and kept in memory for the session. Host and paths are remembered for next time.</p>
         <button class="pt-btn pt-btn-primary" id="wz-connect-btn" type="button">Open connection screen</button>
         <div class="wz-foot">Change later: the LIVE badge, top-right, reopens this screen.</div>`,
    validate: (wiz) => (wiz._connected ? null : 'Please connect to your node first using the button above.'),
  },
  {
    key: 'source',
    title: 'Where should data come from?',
    render: (wiz) => {
      const db = wiz.dbsync || {};
      const dbOn = !!wiz.useDbsync;
      const bfOn = !!wiz.useBlockfrost;
      return `
      <p class="wz-p">Koios, a free public service, is always available - nothing to set up. For richer data
      you can also add your own db-sync database and/or a Blockfrost key. Many operators use one; some use both.</p>

      <div class="wz-base">
        <span class="ds-badge ds-koios">Koios</span>
        <span class="wz-base-t">Always on - pool figures, history and live notifications.</span>
      </div>

      <label class="wz-toggle">
        <input type="checkbox" id="wz-use-dbsync"${dbOn ? ' checked' : ''}>
        <span><span class="wz-toggle-h">Add db-sync</span>
        <span class="wz-toggle-d">Your own Cardano database. Adds full instant history and the loyalty leaderboard, with no API limits.</span></span>
      </label>
      <div class="wz-dbsync" id="wz-dbsync"${dbOn ? '' : ' hidden'}>
        <div class="wz-field"><label>Database name</label>
          <input id="wz-db-name" type="text" value="${db.database || 'cexplorer'}" autocomplete="off"></div>
        <div class="wz-field"><label>Host <span class="wz-opt">(leave blank if db-sync is on the same machine as PoolTerminal)</span></label>
          <input id="wz-db-host" type="text" value="${db.host || ''}" placeholder="blank = local socket" autocomplete="off"></div>
        <div class="wz-row">
          <div class="wz-field" style="flex:0.7"><label>Port</label>
            <input id="wz-db-port" type="number" value="${db.port || 5432}" autocomplete="off"></div>
          <div class="wz-field"><label>User <span class="wz-opt">(blank for local socket)</span></label>
            <input id="wz-db-user" type="text" value="${db.user || ''}" placeholder="cexplorer" autocomplete="off"></div>
        </div>
        <div class="wz-field"><label>Password <span class="wz-opt">(only if your db-sync user needs one)</span></label>
          <input id="wz-db-pass" type="password" value="${db.password || ''}" autocomplete="off"></div>
        <label class="wz-check"><input type="checkbox" id="wz-db-savepass"${db.savePassword ? ' checked' : ''}>
          Remember this password on this machine</label>
        <div class="wz-hint">If db-sync runs on the same machine as PoolTerminal, leave host, port, user and
        password blank - it connects through a local socket. db-sync activates after a successful connection.</div>
      </div>

      <label class="wz-toggle">
        <input type="checkbox" id="wz-use-bf"${bfOn ? ' checked' : ''}>
        <span><span class="wz-toggle-h">Add Blockfrost</span>
        <span class="wz-toggle-d">A project key from blockfrost.io. Adds the delegator deep-dive (full balance, rewards and pool-movement history) and pool lifecycle.</span></span>
      </label>
      <div class="wz-bf" id="wz-bf"${bfOn ? '' : ' hidden'}>
        <div class="wz-field"><label>Blockfrost project key <span class="wz-opt">(mainnet)</span></label>
          <input id="wz-bf-key" type="password" value="${esc(wiz.blockfrostKey || '')}" placeholder="mainnet..." autocomplete="off"></div>
        <div class="wz-hint">Create a free mainnet project at blockfrost.io and paste its project key here.
        It is stored locally on this machine and checked against Blockfrost when you finish.</div>
      </div>

      <div class="wz-foot">Change later: Settings. You can add or remove db-sync and Blockfrost anytime.</div>`;
    },
    collect: (wiz, root) => {
      const dbEl = root.querySelector('#wz-use-dbsync');
      const bfEl = root.querySelector('#wz-use-bf');
      wiz.useDbsync = !!(dbEl && dbEl.checked);
      wiz.useBlockfrost = !!(bfEl && bfEl.checked);
      if (wiz.useDbsync) {
        const v = (id) => { const el = root.querySelector(id); return el ? el.value.trim() : ''; };
        const save = root.querySelector('#wz-db-savepass');
        wiz.dbsync = {
          database: v('#wz-db-name') || 'cexplorer',
          host: v('#wz-db-host'),
          port: Number(v('#wz-db-port')) || 5432,
          user: v('#wz-db-user'),
          password: v('#wz-db-pass'),
          savePassword: !!(save && save.checked),
        };
      }
      if (wiz.useBlockfrost) {
        const k = root.querySelector('#wz-bf-key');
        wiz.blockfrostKey = k ? k.value.trim() : '';
      }
    },
    validate: (wiz, root) => {
      const bfEl = root.querySelector('#wz-use-bf');
      const key = (root.querySelector('#wz-bf-key') || {}).value;
      if (bfEl && bfEl.checked && !(key && key.trim())) {
        return 'Enter your Blockfrost project key, or untick Blockfrost. Koios works on its own.';
      }
      return null;   // Koios baseline is always valid
    },
  },
  {
    key: 'notif',
    title: 'Notifications',
    render: (wiz) => {
      const cur = getNotifSettings();
      const n = wiz.notif || {};
      const tier = n.koiosTier || cur.koiosTier || 'free';
      const pollMs = n.pollMs || cur.pollMs;
      const thresholdAda = (n.thresholdLovelace != null ? n.thresholdLovelace : cur.thresholdLovelace) / 1e6;
      const intervalOpts = POLL_LADDER_MS
        .map((ms) => `<option value="${ms}" ${ms === pollMs ? 'selected' : ''}>${fmtInterval(ms)}</option>`).join('');
      const tierSel = (t) => (tier === t ? 'selected' : '');
      return `
      <p class="wz-p">PoolTerminal can tell you when delegators join, leave, or change their stake.
      Live notifications use Koios, so the check rate is set to stay within its limits - it suggests a safe rate.</p>
      <div class="wz-field"><label>Koios usage tier</label>
        <select id="wz-n-tier">
          <option value="free" ${tierSel('free')}>Free - no key - 5,000 calls/day</option>
          <option value="token" ${tierSel('token')}>Registered token - 50,000 calls/day</option>
        </select>
        <div class="wz-opt">A free Koios token (from koios.rest) lets you check more often. Leave on Free if you don't have one.</div>
      </div>
      <div class="wz-field"><label>Check for changes every</label>
        <div class="wz-row" style="align-items:center">
          <select id="wz-n-interval" style="flex:0 0 130px">${intervalOpts}</select>
          <button class="pt-btn" id="wz-n-suggest" type="button" style="flex:0 0 auto">Use suggested</button>
        </div>
        <div class="wz-hint" id="wz-n-reason"></div>
      </div>
      <div class="wz-field"><label>Only notify for stake changes above</label>
        <div class="wz-row" style="align-items:center">
          <input id="wz-n-threshold" type="number" min="0" step="1" value="${thresholdAda}" style="flex:0 0 130px">
          <span class="wz-opt" style="flex:0 0 auto">ADA - ignores tiny reward drift</span>
        </div>
        <div class="wz-hint" id="wz-n-usage"></div>
      </div>
      <div class="wz-foot">Change later: Settings - the same controls live there.</div>`;
    },
    collect: (wiz, root) => {
      const tierEl = root.querySelector('#wz-n-tier');
      const intEl = root.querySelector('#wz-n-interval');
      const thrEl = root.querySelector('#wz-n-threshold');
      const ada = thrEl ? parseFloat(thrEl.value) : NaN;
      wiz.notif = {
        koiosTier: tierEl ? tierEl.value : (wiz.notif?.koiosTier || 'free'),
        pollMs: intEl ? Number(intEl.value) : (wiz.notif?.pollMs || getNotifSettings().pollMs),
        thresholdLovelace: (Number.isFinite(ada) && ada >= 0) ? Math.round(ada * 1e6) : getNotifSettings().thresholdLovelace,
      };
    },
  },
  {
    key: 'done',
    title: "You're all set",
    render: (wiz) => `
      <p class="wz-lead">That's it - PoolTerminal is ready.</p>
      <div class="wz-summary">
        <div class="wz-sum-row"><span class="wz-sum-k">Runs</span><span class="wz-sum-v">${
          wiz.transport === 'local' ? 'On the node (local)' : wiz.transport === 'ssh' ? 'On a different machine (SSH)' : '-'}</span></div>
        <div class="wz-sum-row"><span class="wz-sum-k">Data sources</span><span class="wz-sum-v">${
          ['Koios', wiz.useDbsync ? 'db-sync' : null, wiz.useBlockfrost ? 'Blockfrost' : null].filter(Boolean).join(' + ')}</span></div>
      </div>
      <div class="wz-note">
        <div class="wz-note-h">Change anything, anytime</div>
        All of these live under the <strong>⚙ Settings</strong> button, top-right. Quick reconnects are on
        the <strong>LIVE</strong> badge.
      </div>
      <div class="wz-note wz-note-amber">
        <div class="wz-note-h">Keeping up to date</div>
        PoolTerminal reads live data from your node and (optionally) a db-sync database. When a Cardano
        <strong>hard fork</strong> happens, you'll need to upgrade your node and db-sync - and sometimes
        PoolTerminal itself. If numbers look wrong after a fork, check those are all up to date.
        <div class="wz-ver">App version ${APP_VERSION}${schemaTested ? ` \u00b7 tested against db-sync schema ${schemaTested}` : ''}</div>
      </div>`,
  },
];

function placeholderHtml(title, desc) {
  return `
    <div class="wz-placeholder">
      <div class="wz-ph-tag">Coming in the next build pass</div>
      <div class="wz-ph-h">${title}</div>
      <div class="wz-ph-d">${desc}</div>
    </div>
    <div class="wz-foot">This step is being wired up - for now, Next continues so you can review the flow.</div>`;
}

const STYLE = `
.pt-modal-wizard { max-width: 620px; }
.wz-progress { display: flex; align-items: center; gap: 8px; margin: 2px 0 4px; }
.wz-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(120,150,190,0.3); transition: background .2s; }
.wz-dot.wz-dot-on { background: var(--pt-accent-blue, #4aa3ff); }
.wz-dot.wz-dot-done { background: #4ade80; }
.wz-step-count { margin-left: auto; font-size: 11px; color: var(--pt-text-muted, #9aa7b4); letter-spacing: .04em; }
.wz-body { padding: 6px 0 4px; min-height: 230px; }
.wz-lead { font-size: 15px; color: var(--pt-text-primary, #e6edf3); line-height: 1.5; margin: 0 0 10px; }
.wz-p { font-size: 13px; color: var(--pt-text-secondary, #b9c4d0); line-height: 1.55; margin: 0 0 12px; }
.wz-note { font-size: 12.5px; line-height: 1.55; color: var(--pt-text-secondary, #b9c4d0);
  background: rgba(74,163,255,0.08); border: 1px solid rgba(74,163,255,0.25); border-radius: 8px; padding: 11px 13px; margin: 12px 0 0; }
.wz-note-amber { background: rgba(251,191,36,0.08); border-color: rgba(251,191,36,0.28); }
.wz-note-h { font-weight: 700; color: var(--pt-text-primary, #e6edf3); margin-bottom: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
.wz-ver { margin-top: 8px; font-family: ui-monospace, monospace; font-size: 11px; color: var(--pt-text-muted, #9aa7b4); }
.wz-foot { margin-top: 14px; font-size: 11px; color: var(--pt-text-muted, #9aa7b4); opacity: .85; }

.wz-cards { display: flex; flex-direction: column; gap: 10px; }
.wz-card { text-align: left; cursor: pointer; border-radius: 10px; padding: 14px 16px;
  background: rgba(120,150,190,0.05); border: 1.5px solid rgba(120,150,190,0.22); color: inherit; transition: border-color .15s, background .15s; }
.wz-card:hover { border-color: rgba(120,150,190,0.45); }
.wz-card-on { border-color: var(--pt-accent-blue, #4aa3ff); background: rgba(74,163,255,0.1); }
.wz-card-h { font-size: 14px; font-weight: 700; color: var(--pt-text-primary, #e6edf3); margin-bottom: 3px; }
.wz-card-d { font-size: 12.5px; color: var(--pt-text-secondary, #b9c4d0); line-height: 1.5; }
.wz-card-w { font-size: 11.5px; color: var(--pt-text-muted, #9aa7b4); margin-top: 6px; font-style: italic; }

.wz-placeholder { border: 1.5px dashed rgba(120,150,190,0.3); border-radius: 10px; padding: 22px; text-align: center; }
.wz-ph-tag { display: inline-block; font-size: 10px; text-transform: uppercase; letter-spacing: .06em;
  color: var(--pt-accent-blue, #4aa3ff); border: 1px solid rgba(74,163,255,0.4); border-radius: 20px; padding: 3px 10px; margin-bottom: 12px; }
.wz-ph-h { font-size: 15px; font-weight: 700; color: var(--pt-text-primary, #e6edf3); margin-bottom: 6px; }
.wz-ph-d { font-size: 12.5px; color: var(--pt-text-secondary, #b9c4d0); line-height: 1.55; max-width: 420px; margin: 0 auto; }

.wz-summary { margin: 4px 0; border: 1px solid rgba(120,150,190,0.2); border-radius: 8px; overflow: hidden; }
.wz-sum-row { display: flex; justify-content: space-between; padding: 9px 13px; font-size: 13px; border-top: 1px solid rgba(120,150,190,0.12); }
.wz-sum-row:first-child { border-top: 0; }
.wz-sum-k { color: var(--pt-text-muted, #9aa7b4); text-transform: uppercase; font-size: 11px; letter-spacing: .05em; }
.wz-sum-v { color: var(--pt-text-primary, #e6edf3); font-weight: 600; }
.wz-err { color: #fb7185; font-size: 12.5px; margin-top: 10px; min-height: 16px; }

.wz-card-disabled { opacity: .5; cursor: not-allowed; }
.wz-soon { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--pt-accent-blue, #4aa3ff);
  border: 1px solid rgba(74,163,255,.4); border-radius: 10px; padding: 1px 7px; margin-left: 6px; vertical-align: middle; }
.wz-dbsync { margin-top: 12px; padding: 14px; border: 1px solid rgba(120,150,190,.22); border-radius: 10px; background: rgba(120,150,190,.04); }
.wz-sub-h { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--pt-text-muted, #9aa7b4); margin-bottom: 10px; font-weight: 700; }
.wz-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.wz-field > label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--pt-text-muted, #9aa7b4); }
.wz-row { display: flex; gap: 10px; }
.wz-row .wz-field { flex: 1; }
.wz-opt { text-transform: none; letter-spacing: 0; opacity: .7; font-size: 11px; }
.wz-check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--pt-text-secondary, #b9c4d0); margin: 4px 0 8px; cursor: pointer; text-transform: none; letter-spacing: 0; }
.wz-hint { font-size: 11.5px; color: var(--pt-text-muted, #9aa7b4); line-height: 1.5; margin-top: 2px; }
.wz-hint.wz-warn { color: #fb7185; }
.wz-ok { font-size: 15px; font-weight: 700; color: #4ade80; margin-bottom: 10px; }

.wz-base { display: flex; align-items: center; gap: 10px; margin: 0 0 14px; padding: 10px 12px;
  border-radius: 9px; background: rgba(74,163,255,0.07); border: 1px solid rgba(74,163,255,0.2); }
.wz-base-t { font-size: 12.5px; color: var(--pt-text-secondary, #b9c4d0); }
.wz-toggle { display: flex; align-items: flex-start; gap: 11px; cursor: pointer; padding: 12px 13px;
  border-radius: 9px; border: 1px solid rgba(120,150,190,0.2); background: rgba(120,150,190,0.04); margin-bottom: 8px; }
.wz-toggle input { margin-top: 2px; width: auto !important; flex: 0 0 auto; }
.wz-toggle-h { font-size: 13.5px; font-weight: 700; color: var(--pt-text-primary, #e6edf3); display: block; }
.wz-toggle-d { font-size: 12px; color: var(--pt-text-muted, #9aa7b4); line-height: 1.45; display: block; margin-top: 2px; }
.wz-dbsync, .wz-bf { margin: 0 0 12px; padding: 14px; border: 1px solid rgba(120,150,190,0.22);
  border-radius: 10px; background: rgba(120,150,190,0.04); }
/* data-source badge colours (shared look with the Data tab) */
.ds-badge { display: inline-block; font-size: 11px; font-weight: 700; padding: 3px 10px; border-radius: 20px; border: 1px solid; white-space: nowrap; }
.ds-koios { color: #4aa3ff; border-color: rgba(74,163,255,0.4); background: rgba(74,163,255,0.1); }

/* WebKitGTK-safe inputs/selects (same treatment as connect/settings dialogs). */
.pt-modal-wizard input, .pt-modal-wizard select {
  background-color: #0e1620 !important; color: #fff !important; -webkit-text-fill-color: #fff !important;
  border: 1px solid rgba(120,150,190,.5) !important; border-radius: 4px !important; padding: 7px 9px !important;
  font: 600 13px ui-monospace, monospace !important; box-sizing: border-box !important; width: 100%; }
.pt-modal-wizard select {
  -webkit-appearance: none !important; appearance: none !important; background-color: #16202e !important;
  background-image: linear-gradient(45deg, transparent 50%, #9fb4cc 50%), linear-gradient(135deg, #9fb4cc 50%, transparent 50%) !important;
  background-position: right 14px center, right 9px center !important; background-size: 5px 5px, 5px 5px !important;
  background-repeat: no-repeat, no-repeat !important; padding-right: 28px !important; cursor: pointer; }
.pt-modal-wizard select option { background-color: #0e1620 !important; color: #fff !important; -webkit-text-fill-color: #fff !important; }
.pt-modal-wizard input[type="checkbox"] { width: auto !important; }
`;

export function showSetupWizard(opts = {}) {
  if (document.getElementById('wz-modal')) return;
  const onComplete = typeof opts.onComplete === 'function' ? opts.onComplete : null;
  const wiz = Object.assign(freshState(), opts._resume || {});
  let idx = Number.isInteger(opts._startIndex) ? opts._startIndex : 0;

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="pt-modal-backdrop" id="wz-modal">
      <div class="pt-modal pt-modal-wizard">
        <div class="wz-progress" id="wz-progress"></div>
        <div class="pt-modal-header">
          <div class="pt-modal-title" id="wz-title"></div>
        </div>
        <style>${STYLE}</style>
        <div class="wz-body" id="wz-body"></div>
        <div class="wz-err" id="wz-err"></div>
        <div class="pt-modal-actions">
          <button class="pt-btn" id="wz-back">Back</button>
          <button class="pt-btn pt-btn-primary" id="wz-next">Next</button>
        </div>
      </div>
    </div>`;
  const modal = wrap.firstElementChild;
  document.body.appendChild(modal);

  const $ = (id) => modal.querySelector(id);

  function paint() {
    const step = STEPS[idx];
    $('#wz-title').textContent = step.title;
    $('#wz-body').innerHTML = step.render(wiz);
    $('#wz-err').textContent = '';

    // progress dots
    $('#wz-progress').innerHTML =
      STEPS.map((_, i) => `<span class="wz-dot ${i === idx ? 'wz-dot-on' : i < idx ? 'wz-dot-done' : ''}"></span>`).join('') +
      `<span class="wz-step-count">Step ${idx + 1} of ${STEPS.length}</span>`;

    $('#wz-back').style.visibility = idx === 0 ? 'hidden' : 'visible';
    $('#wz-next').textContent = idx === STEPS.length - 1 ? 'Finish' : 'Next';

    if (step.key === 'connect') {
      const btn = modal.querySelector('#wz-connect-btn');
      if (btn) btn.addEventListener('click', () => {
        // Hand off to the existing connection screen (kept unforked). On a live
        // connect we capture the pool hex (POOL_ID) for db-sync init, then resume
        // the wizard at the data-source step carrying all choices so far.
        const saved = { ...wiz };
        const sourceIdx = STEPS.findIndex((s) => s.key === 'source');
        modal.remove();
        showConnectModal((res) => {
          if (res && res.mode === 'live') {
            saved._connected = true;
            saved.poolHex = (res.envVars && res.envVars.POOL_ID) || null;
          }
          showSetupWizard({ onComplete, _resume: saved, _startIndex: sourceIdx });
        });
      });
    }

    // step-specific wiring (Pass 1: transport cards)
    if (step.key === 'transport') {
      modal.querySelectorAll('.wz-card').forEach((card) => {
        card.addEventListener('click', () => {
          wiz.transport = card.dataset.choice;
          modal.querySelectorAll('.wz-card').forEach((c) => c.classList.toggle('wz-card-on', c === card));
          $('#wz-err').textContent = '';
        });
      });
    }

    if (step.key === 'source') {
      const dbToggle = modal.querySelector('#wz-use-dbsync');
      if (dbToggle) dbToggle.addEventListener('change', () => {
        const f = modal.querySelector('#wz-dbsync'); if (f) f.hidden = !dbToggle.checked;
        $('#wz-err').textContent = '';
      });
      const bfToggle = modal.querySelector('#wz-use-bf');
      if (bfToggle) bfToggle.addEventListener('change', () => {
        const f = modal.querySelector('#wz-bf'); if (f) f.hidden = !bfToggle.checked;
        $('#wz-err').textContent = '';
      });
    }

    if (step.key === 'notif') {
      const recompute = () => {
        const tierEl = modal.querySelector('#wz-n-tier');
        const tier = tierEl ? tierEl.value : 'free';
        const intEl = modal.querySelector('#wz-n-interval');
        const intervalMs = intEl ? Number(intEl.value) : getNotifSettings().pollMs;
        const source = 'koios';   // live notifications run on Koios
        const count = wiz._delegCount || 0;
        const sug = suggestPollMs({ delegatorCount: count, source, koiosTier: tier });
        const reasonEl = modal.querySelector('#wz-n-reason');
        if (reasonEl) {
          reasonEl.textContent = count > 0
            ? `Suggested ${fmtInterval(sug.ms)} - ${sug.reason}`
            : `Suggested ${fmtInterval(sug.ms)} as a safe starting point. This fine-tunes once connected, since it depends on your delegator count.`;
        }
        const sBtn = modal.querySelector('#wz-n-suggest');
        if (sBtn) sBtn.dataset.ms = String(sug.ms);
        const usageEl = modal.querySelector('#wz-n-usage');
        if (usageEl) {
          if (count > 0) {
            const u = pollUsage({ ms: intervalMs, delegatorCount: count, source, koiosTier: tier });
            let t = `At ${fmtInterval(intervalMs)}: ~${u.callsPerDay.toLocaleString()} Koios calls/day of ${u.budget.toLocaleString()} allowed.`;
            if (u.breaches) t += ' Over budget - choose a longer interval or a registered token.';
            usageEl.textContent = t; usageEl.classList.toggle('wz-warn', u.breaches);
          } else { usageEl.textContent = ''; }
        }
      };
      ['#wz-n-tier', '#wz-n-interval'].forEach((id) => { const el = modal.querySelector(id); if (el) el.addEventListener('change', recompute); });
      const sg = modal.querySelector('#wz-n-suggest');
      if (sg) sg.addEventListener('click', () => {
        const ms = Number(sg.dataset.ms); const sel = modal.querySelector('#wz-n-interval');
        if (ms && sel) { sel.value = String(ms); recompute(); }
      });
      recompute();
    }
  }

  $('#wz-back').addEventListener('click', () => { if (idx > 0) { idx--; paint(); } });
  $('#wz-next').addEventListener('click', () => {
    const step = STEPS[idx];
    if (step.validate) {
      const err = step.validate(wiz, modal);
      if (err) { $('#wz-err').textContent = err; return; }
    }
    if (step.collect) step.collect(wiz, modal);
    if (idx < STEPS.length - 1) { idx++; paint(); }
    else {
      const nextBtn = $('#wz-next');
      nextBtn.disabled = true;
      applyWizard(wiz).finally(() => {
        modal.remove();
        if (onComplete) onComplete(wiz);
      });
    }
  });

  paint();
}

/** Persist the data-source choices (no db-sync password unless opted in; the
 *  Blockfrost key is persisted by setBlockfrostKey, so only a flag is kept here). */
function saveSourceChoice(wiz) {
  const out = { koios: true, useDbsync: !!wiz.useDbsync, useBlockfrost: !!wiz.useBlockfrost };
  if (wiz.useDbsync && wiz.dbsync) {
    const d = wiz.dbsync;
    out.dbsync = {
      database: d.database || 'cexplorer',
      host: d.host || '',
      port: d.port || 5432,
      user: d.user || '',
      savePassword: !!d.savePassword,
      password: d.savePassword ? (d.password || '') : '',
    };
  }
  try { localStorage.setItem('poolterminal.source.v1', JSON.stringify(out)); }
  catch (e) { console.warn('[wizard] source save failed:', e.message ?? e); }
}

/** Map the wizard db-sync inputs to an initDbsync config (blank host = local socket). */
function buildDbsyncConfig(d = {}) {
  const cfg = { database: d.database || 'cexplorer' };
  if (d.host) { cfg.host = d.host; cfg.port = d.port || 5432; if (d.user) cfg.user = d.user; if (d.password) cfg.password = d.password; }
  return cfg;
}

/** Apply the collected choices. Koios is always on; db-sync and Blockfrost are
 *  optional add-ons activated when chosen (db-sync needs the connected pool hex). */
async function applyWizard(wiz) {
  try {
    const n = wiz.notif || {};
    saveNotifSettings({
      koiosTier: n.koiosTier || 'free',
      pollMs: n.pollMs || getNotifSettings().pollMs,
      thresholdLovelace: n.thresholdLovelace != null ? n.thresholdLovelace : getNotifSettings().thresholdLovelace,
    });
  } catch (e) { console.warn('[wizard] notif save failed:', e.message ?? e); }

  try { saveSourceChoice(wiz); } catch (e) { console.warn('[wizard] source save failed:', e.message ?? e); }

  if (wiz.useDbsync && wiz.poolHex) {
    try {
      const ok = await initDbsync(buildDbsyncConfig(wiz.dbsync), wiz.poolHex);
      console.log(ok ? '[wizard] db-sync activated' : '[wizard] db-sync not reachable - Koios still serves history');
    } catch (e) { console.warn('[wizard] db-sync init failed:', e.message ?? e); }
  }

  if (wiz.useBlockfrost && wiz.blockfrostKey) {
    try {
      const ok = await applyBlockfrostKey(wiz.blockfrostKey);
      console.log(ok ? '[wizard] Blockfrost activated' : '[wizard] Blockfrost key set but not reachable - check the key');
    } catch (e) { console.warn('[wizard] Blockfrost init failed:', e.message ?? e); }
  } else if (!wiz.useBlockfrost) {
    // Left unticked: do not touch an existing key here (managed in Settings).
  }
}
