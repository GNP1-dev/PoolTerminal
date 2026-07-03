/**
 * PoolTerminal - first-run SETUP WIZARD (branching, one-decision-per-screen).
 *
 * Shown on first run (no saved config) and re-runnable from Settings. The flow
 * adapts to the operator's choices:
 *
 *   Welcome -> Where it runs -> Connect -> Richer data? (hub)
 *     -> Do you run db-sync?  (Yes reveals connection + credentials)
 *     -> Do you have Blockfrost? (wording adapts to the db-sync choice)
 *     -> Notifications cadence -> Summary
 *
 * Design rules: one clear decision per screen, plain language, every choice says
 * where to change it later, optional inputs say plainly when to skip them. Each
 * source has a consistent accent colour (Koios blue, db-sync teal, Blockfrost
 * violet, node green) carried through to the summary so the operator builds a
 * mental map. Connect hands off to the existing connection screen unchanged.
 *
 * Reuses the WebKitGTK-safe input/select treatment from the connect/settings
 * dialogs, the notif-settings advisor, and the tested applyWizard plumbing.
 */

import { DBSYNC_TESTED_SCHEMA as schemaTested, initDbsync } from '../data/dbsync-query.js';
import { suggestPollMs, pollUsage, fmtInterval, POLL_LADDER_MS, getNotifSettings, saveNotifSettings } from '../data/notif-settings.js';
import { showConnectModal } from './connect.js';
import { setMode } from '../data/index.js';
import { isConnected, getSession } from '../data/session.js';
import { applyBlockfrostKey } from '../data/read-model.js';
import { setKoiosToken, hasKoiosToken, getKoiosToken } from '../data/koios-token.js';
import { setPaused } from '../data/koios-meter.js';
import { SSH_TUNNEL_ENABLED } from '../data/pg-transport.js';

const APP_VERSION = '0.1.0';   // keep in step with package.json

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ── wizard state (accumulates choices; applied on Finish) ────────────────────
function freshState() {
  return {
    transport: null,        // 'ssh' | 'local'
    conn: {},               // host/port/user/env/auth
    _connected: false,
    poolHex: null,
    useDbsync: false,       // optional db-sync
    dbsyncMode: 'local',    // 'local' | 'tcp' | 'tunnel'
    dbsync: {},             // db-sync DB creds
    useBlockfrost: false,   // optional Blockfrost
    blockfrostKey: '',      // Blockfrost project key
    koiosMode: getKoiosToken() ? 'key' : null,   // 'free' | 'key' - chosen on the Koios step
    koiosToken: getKoiosToken() || '',   // preloaded so a wizard re-run never wipes an existing token /*wz-koios-preserve-v33*/
    notif: {},              // poll cadence + threshold
  };
}

// Yes/No card pair used by the db-sync and Blockfrost screens.
function yesNoCards(onChoice, isYes) {
  return `
    <div class="wz-cards wz-cards-row">
      <button class="wz-card wz-card-sm ${isYes === true ? 'wz-card-on' : ''}" data-yn="yes" type="button">
        <div class="wz-card-h">Yes</div></button>
      <button class="wz-card wz-card-sm ${isYes === false ? 'wz-card-on' : ''}" data-yn="no" type="button">
        <div class="wz-card-h">No / skip</div></button>
    </div>`;
}

// ── shared visual helpers: icon marks + a consistent screen header ───────────
const ICON_LOC = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-6-5.4-6-10a6 6 0 0 1 12 0c0 4.6-6 10-6 10z"/><circle cx="12" cy="11" r="2"/></svg>';
const ICON_NETWORK = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M5 12h11M12 8l4 4-4 4"/><rect x="18" y="4" width="3" height="16" rx="1"/></svg>';
const ICON_DESKTOP = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/></svg>';
const ICON_KOIOS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18"/></svg>';
const ICON_FREE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="9" width="18" height="12" rx="1"/><path d="M3 13h18M12 9v12M12 9C10 9 8.2 7.6 8.7 6.1S12 7 12 9zM12 9c2 0 3.8-1.4 3.3-2.9S12 7 12 9z"/></svg>';
const ICON_KEYC = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="8" cy="12" r="4.5"/><path d="M12.5 12H21M18 12v3.5M21 12v2.5"/></svg>';
const ICON_DB = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/></svg>';  /*wz-style-v40*/
const ICON_BF = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M12 12l9-5M12 12v10M12 12L3 7"/></svg>';
const ICON_BELL = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 9a6 6 0 0 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 0 0 4 0"/></svg>';
function wzHead(icon, text) {
  return `<div class="wz-lead-row"><span class="wz-mark">${icon}</span><span class="wz-lead-t">${text}</span></div>`;
}

// ── steps ────────────────────────────────────────────────────────────────────
const STEPS = [
  {
    key: 'welcome',
    title: 'Welcome to PoolTerminal',
    render: () => `
      <div class="wz-hero">
        <div class="wz-hero-mark"><span class="wz-hero-icon">PT</span></div>
        <div class="wz-hero-title">Your pool, on one screen.</div>
        <p class="wz-hero-sub">Live blocks, delegators and rewards, plus full node and relay metrics, for your
        Cardano stake pool. Let us get you connected in under a minute.</p>
      </div>
      <div class="wz-note">You can change any answer later from <strong>Settings</strong>, top-right -
      nothing here is permanent.</div>
      <div class="wz-demo-row"><button class="wz-demo-btn" id="wz-demo" type="button">Just exploring? Open a demo with sample data</button></div>`,
  },
  {
    key: 'transport',
    title: 'Where does PoolTerminal run?',
    render: (wiz) => `
      ${wzHead(ICON_LOC, 'Pick where this app is running, relative to your Cardano node.')}
      <div class="wz-cards">
        <button class="wz-card wz-card-ico ${wiz.transport === 'ssh' ? 'wz-card-on' : ''}" data-choice="ssh" type="button">
          <span class="wz-card-ic">${ICON_NETWORK}</span>
          <span class="wz-card-body">
            <span class="wz-card-h">On a different machine</span>
            <span class="wz-card-d">PoolTerminal connects to your node over SSH. This is the usual choice - e.g. the app on your laptop, the node on a server.</span>
          </span>
        </button>
        <button class="wz-card wz-card-ico ${wiz.transport === 'local' ? 'wz-card-on' : ''}" data-choice="local" type="button">
          <span class="wz-card-ic">${ICON_DESKTOP}</span>
          <span class="wz-card-body">
            <span class="wz-card-h">On the node itself</span>
            <span class="wz-card-d">PoolTerminal runs commands locally - no SSH or password needed.</span>
          </span>
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
    key: 'koios',
    title: 'Koios access',
    accent: 'koios',
    render: (wiz) => {
      const mode = wiz.koiosMode || ((wiz.koiosToken || '').trim() ? 'key' : null);
      return `
      ${wzHead(ICON_KOIOS, "Koios is a free public API for pool figures, delegators, history, rewards and the deep-dive. Choose how you'll reach it.")}
      <div class="wz-cards">
        <button class="wz-card wz-card-ico ${mode === 'free' ? 'wz-card-on' : ''}" data-koios="free" type="button">
          <span class="wz-card-ic">${ICON_FREE}</span>
          <span class="wz-card-body">
            <span class="wz-card-h">Use the free tier</span>
            <span class="wz-card-d">No key needed. Rate-limited to about 5,000 calls a day. PoolTerminal eases the poll rate to stay within it.</span>
          </span>
        </button>
        <button class="wz-card wz-card-ico ${mode === 'key' ? 'wz-card-on' : ''}" data-koios="key" type="button">
          <span class="wz-card-ic">${ICON_KEYC}</span>
          <span class="wz-card-body">
            <span class="wz-card-h">I have a Koios API key</span>
            <span class="wz-card-d">Registered projects get 50,000 calls a day and skip shared-IP limits. Free to create at koios.rest.</span>
          </span>
        </button>
      </div>
      <div class="wz-reveal ${mode === 'key' ? 'wz-reveal-open' : ''}" id="wz-koios-fields">
        <div class="wz-field"><label>Koios API token</label>
          <input id="wz-koios-token" type="password" value="${esc(wiz.koiosToken || '')}" placeholder="paste your Koios bearer token" autocomplete="off" spellcheck="false">
          <div class="wz-hint">${hasKoiosToken() ? 'A token is currently set - leave it to keep it. ' : ''}Sign in at koios.rest, create an API token, then paste it here.</div>
        </div>
      </div>
      <div class="wz-foot">Change later: Settings. /*wz-koios-step-v34*/</div>`;
    },
    collect: (wiz, root) => {
      const t = root.querySelector('#wz-koios-token');
      const tok = t ? t.value.trim() : '';
      if (tok) wiz.koiosMode = 'key';   // a pasted key implies the key option
      wiz.koiosToken = wiz.koiosMode === 'key' ? tok : '';
    },
    validate: (wiz, root) => {
      const mode = wiz.koiosMode;
      if (!mode) return 'Choose the free tier, or enter a Koios API key.';
      if (mode === 'key') {
        const t = (root.querySelector('#wz-koios-token') || {}).value;
        if (!(t && t.trim())) return 'Paste your Koios API key, or choose the free tier.';
      }
      return null;
    },
  },
  {
    key: 'dbsync',
    title: 'Do you run db-sync?',
    accent: 'dbsync',
    render: (wiz) => {
      const db = wiz.dbsync || {};
      const yn = wiz._dbAnswered ? !!wiz.useDbsync : null;
      const mode = wiz.dbsyncMode || 'local';
      const tunnelOpt = SSH_TUNNEL_ENABLED
        ? `<option value="tunnel" ${mode === 'tunnel' ? 'selected' : ''}>Through the SSH connection to your node (tunnel)</option>` : '';
      const showCreds = mode !== 'local';
      return `
      ${wzHead(ICON_DB, "<span class='wz-src wz-dbsync'>db-sync</span> is your own copy of the Cardano database. If you run one, PoolTerminal reads it directly - adding the <strong>loyalty leaderboard</strong>, full instant history and the delegator deep-dive, with no API limits.")}
      ${yesNoCards(null, yn)}
      <div class="wz-reveal ${yn === true ? 'wz-reveal-open' : ''}" id="wz-dbsync-fields">
        <div class="wz-field"><label>How is db-sync reached?</label>
          <select id="wz-db-mode">
            <option value="local" ${mode === 'local' ? 'selected' : ''}>On the same machine as PoolTerminal (local socket)</option>
            <option value="tcp" ${mode === 'tcp' ? 'selected' : ''}>Over the network (direct connection)</option>
            ${tunnelOpt}
          </select>
        </div>
        <div class="wz-field"><label>Database name</label>
          <input id="wz-db-name" type="text" value="${esc(db.database || 'cexplorer')}" autocomplete="off"></div>
        <div class="wz-creds ${showCreds ? '' : 'wz-creds-hidden'}" id="wz-db-creds">
          <div class="wz-field"><label>Host${mode === 'tunnel' ? ' <span class="wz-opt">(as seen from the node; usually 127.0.0.1)</span>' : ''}</label>
            <input id="wz-db-host" type="text" value="${esc(db.host || (mode === 'tunnel' ? '127.0.0.1' : ''))}" autocomplete="off"></div>
          <div class="wz-row">
            <div class="wz-field" style="flex:0.7"><label>Port</label>
              <input id="wz-db-port" type="number" value="${db.port || 5432}" autocomplete="off"></div>
            <div class="wz-field"><label>User</label>
              <input id="wz-db-user" type="text" value="${esc(db.user || '')}" placeholder="cexplorer" autocomplete="off"></div>
          </div>
          <div class="wz-field"><label>Password <span class="wz-opt">(only if your db-sync user needs one)</span></label>
            <input id="wz-db-pass" type="password" value="${esc(db.password || '')}" autocomplete="off"></div>
          <label class="wz-check"><input type="checkbox" id="wz-db-savepass"${db.savePassword ? ' checked' : ''}>
            Remember this password on this machine</label>
        </div>
        <div class="wz-hint" id="wz-db-hint"></div>
        <div class="wz-testrow">
          <button class="pt-btn" id="wz-db-test" type="button">Test connection</button>
          <span class="wz-test-result" id="wz-db-test-result"></span>
        </div>
      </div>
      <div class="wz-foot">Not sure? Choose No - Koios covers history and the deep-dive. You can add db-sync later.</div>`;
    },
    collect: (wiz, root) => {
      // useDbsync + answered flag are set by the Yes/No handler; here we gather creds.
      if (wiz.useDbsync) {
        const modeEl = root.querySelector('#wz-db-mode');
        wiz.dbsyncMode = modeEl ? modeEl.value : 'local';
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
    },
    validate: (wiz) => (wiz._dbAnswered ? null : 'Please choose Yes or No.'),
  },
  {
    key: 'blockfrost',
    title: 'Do you have a Blockfrost key?',
    accent: 'bf',
    render: (wiz) => {
      const yn = wiz._bfAnswered ? !!wiz.useBlockfrost : null;
      const lead = wiz.useDbsync
        ? wzHead(ICON_BF, "You've added <span class='wz-src wz-dbsync'>db-sync</span>, which already gives the deep-dive and more, so <span class='wz-src wz-bf'>Blockfrost</span> is optional here. Add it only if you'd like a second source as backup.")
        : wzHead(ICON_BF, "<span class='wz-src wz-bf'>Blockfrost</span> is a free public API. A project key adds the delegator deep-dive and pool summary. Worth adding if you're not running db-sync - though Koios provides these too, so you can happily skip it.");
      return `
      ${lead}
      ${yesNoCards(null, yn)}
      <div class="wz-reveal ${yn === true ? 'wz-reveal-open' : ''}" id="wz-bf-fields">
        <div class="wz-field"><label>Blockfrost project key <span class="wz-opt">(mainnet)</span></label>
          <input id="wz-bf-key" type="password" value="${esc(wiz.blockfrostKey || '')}" placeholder="mainnet..." autocomplete="off"></div>
        <div class="wz-hint">Create a free mainnet project at blockfrost.io and paste its project key here. It's
        stored locally on this machine and checked against Blockfrost when you finish.</div>
        <div class="wz-testrow">
          <button class="pt-btn" id="wz-bf-test" type="button">Test key</button>
          <span class="wz-test-result" id="wz-bf-test-result"></span>
        </div>
      </div>
      <div class="wz-foot">Change later: Settings. You can add or remove Blockfrost anytime.</div>`;
    },
    collect: (wiz, root) => {
      if (wiz.useBlockfrost) {
        const k = root.querySelector('#wz-bf-key');
        wiz.blockfrostKey = k ? k.value.trim() : '';
      }
    },
    validate: (wiz, root) => {
      if (!wiz._bfAnswered) return 'Please choose Yes or No.';
      if (wiz.useBlockfrost) {
        const key = (root.querySelector('#wz-bf-key') || {}).value;
        if (!(key && key.trim())) return 'Enter your Blockfrost project key, or choose No. Koios works on its own.';
      }
      return null;
    },
  },
  {
    key: 'notif',
    title: 'Notifications',
    render: (wiz) => {
      const cur = getNotifSettings();
      const n = wiz.notif || {};
      const tier = n.koiosTier || ((wiz.koiosToken || '').trim() ? 'token' : (cur.koiosTier || 'free'));
      const pollMs = n.pollMs || cur.pollMs;
      const thresholdAda = (n.thresholdLovelace != null ? n.thresholdLovelace : cur.thresholdLovelace) / 1e6;
      const intervalOpts = POLL_LADDER_MS
        .map((ms) => `<option value="${ms}" ${ms === pollMs ? 'selected' : ''}>${fmtInterval(ms)}</option>`).join('');
      const tierSel = (t) => (tier === t ? 'selected' : '');
      // Which source will answer live delegator notifications (db-sync > Blockfrost > Koios).
      const notifSource = wiz.useDbsync ? 'dbsync' : (wiz.useBlockfrost ? 'blockfrost' : 'koios');
      const intro = notifSource === 'dbsync'
        ? wzHead(ICON_BELL, "PoolTerminal tells you when delegators join, leave or change their stake. Live notifications read your <span class='wz-src wz-dbsync'>db-sync</span> directly, so there are no API limits - pick any check rate you like.")
        : notifSource === 'blockfrost'
        ? wzHead(ICON_BELL, "PoolTerminal tells you when delegators join, leave or change their stake. Live notifications use <span class='wz-src wz-bf'>Blockfrost</span> (50,000 calls/day free), so the check rate is set to stay within budget - it suggests a safe rate.")
        : wzHead(ICON_BELL, "PoolTerminal tells you when delegators join, leave or change their stake. Live notifications use <span class='wz-src wz-koios'>Koios</span>, so the check rate is set to stay within its limits - it suggests a safe rate.");
      const tierField = '';   // tier is derived from the Koios screen choice  /*wz-notif-clean-v42*/
      return `
      ${intro}
      ${tierField}
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
      const intEl = root.querySelector('#wz-n-interval');
      const thrEl = root.querySelector('#wz-n-threshold');
      const ada = thrEl ? parseFloat(thrEl.value) : NaN;
      wiz.notif = {
        koiosTier: (wiz.koiosToken || '').trim() ? 'token' : 'free',
        pollMs: intEl ? Number(intEl.value) : (wiz.notif?.pollMs || getNotifSettings().pollMs),
        thresholdLovelace: (Number.isFinite(ada) && ada >= 0) ? Math.round(ada * 1e6) : getNotifSettings().thresholdLovelace,
      };
    },
  },
  {
    key: 'done',
    title: "You're all set",
    render: (wiz) => {
      const chip = (cls, label) => `<span class="wz-pill wz-pill-${cls}">${label}</span>`;
      const chips = [chip('node', 'Node'), chip('koios', 'Koios')];
      if (wiz.useDbsync) chips.push(chip('dbsync', 'db-sync'));
      if (wiz.useBlockfrost) chips.push(chip('bf', 'Blockfrost'));
      return `
      <p class="wz-lead">That's it - PoolTerminal is ready.</p>
      <div class="wz-sumchips">${chips.join('')}</div>
      <div class="wz-summary">
        <div class="wz-sum-row"><span class="wz-sum-k">Runs</span><span class="wz-sum-v">${
          wiz.transport === 'local' ? 'On the node (local)' : wiz.transport === 'ssh' ? 'On a different machine (SSH)' : '-'}</span></div>
        <div class="wz-sum-row"><span class="wz-sum-k">Loyalty leaderboard</span><span class="wz-sum-v">${
          wiz.useDbsync ? 'On (db-sync)' : 'Needs db-sync'}</span></div>
        <div class="wz-sum-row"><span class="wz-sum-k">Deep-dive</span><span class="wz-sum-v">${
          wiz.useDbsync ? 'db-sync' : (wiz.useBlockfrost ? 'Blockfrost' : 'Koios')}</span></div>
      </div>
      <div class="wz-note wz-note-amber">
        <div class="wz-note-h">Keeping up to date</div>
        PoolTerminal reads live data from your node and (optionally) a db-sync database. When a Cardano
        <strong>hard fork</strong> happens, you'll need to upgrade your node and db-sync - and sometimes
        PoolTerminal itself. If numbers look wrong after a fork, check those are all up to date.
        <div class="wz-ver">App version ${APP_VERSION}${schemaTested ? ` \u00b7 tested against db-sync schema ${schemaTested}` : ''}</div>
      </div>
      <div class="wz-foot">Change anything anytime from <strong>⚙ Settings</strong>, top-right.</div>`;
    },
  },
];

const STYLE = `
.pt-modal-wizard { max-width: 620px; }
.wz-progress { display: flex; align-items: center; gap: 8px; margin: 2px 0 4px; }
.wz-dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(120,150,190,0.3); transition: background .25s, transform .25s; }
.wz-dot.wz-dot-on { background: var(--pt-accent-blue, #4aa3ff); transform: scale(1.35); }
.wz-dot.wz-dot-done { background: #4ade80; }
.wz-step-count { margin-left: auto; font-size: 11px; color: var(--pt-text-muted, #9aa7b4); letter-spacing: .04em; }
.wz-body { padding: 6px 0 4px; min-height: 250px; }
.wz-anim { animation: wzIn .26s cubic-bezier(.22,.61,.36,1); }
@keyframes wzIn { from { opacity: 0; transform: translateY(7px); } to { opacity: 1; transform: none; } }
.wz-lead { font-size: 15px; color: var(--pt-text-primary, #e6edf3); line-height: 1.5; margin: 0 0 12px; }
.wz-p { font-size: 13px; color: var(--pt-text-secondary, #b9c4d0); line-height: 1.55; margin: 0 0 12px; }
.wz-note { font-size: 12.5px; line-height: 1.55; color: var(--pt-text-secondary, #b9c4d0);
  background: rgba(74,163,255,0.08); border: 1px solid rgba(74,163,255,0.25); border-radius: 8px; padding: 11px 13px; margin: 12px 0 0; }
.wz-note-amber { background: rgba(251,191,36,0.08); border-color: rgba(251,191,36,0.28); }
.wz-note-h { font-weight: 700; color: var(--pt-text-primary, #e6edf3); margin-bottom: 4px; font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
.wz-ver { margin-top: 8px; font-family: ui-monospace, monospace; font-size: 11px; color: var(--pt-text-muted, #9aa7b4); }
.wz-foot { margin-top: 14px; font-size: 11px; color: var(--pt-text-muted, #9aa7b4); opacity: .85; }

/* source accent colours, reused across screens + summary */
.wz-src { font-weight: 700; padding: 1px 8px; border-radius: 20px; font-size: 12px; border: 1px solid; white-space: nowrap; }
.wz-koios { color: #4aa3ff; border-color: rgba(74,163,255,0.45); background: rgba(74,163,255,0.12); }
.wz-dbsync { color: #2dd4bf; border-color: rgba(45,212,191,0.45); background: rgba(45,212,191,0.12); }
.wz-bf { color: #a78bfa; border-color: rgba(167,139,250,0.45); background: rgba(167,139,250,0.12); }
.wz-pill { display: inline-block; font-size: 12px; font-weight: 700; padding: 4px 12px; border-radius: 20px; border: 1px solid; }
.wz-pill-node { color: #4ade80; border-color: rgba(74,222,128,0.45); background: rgba(74,222,128,0.12); }
.wz-pill-koios { color: #4aa3ff; border-color: rgba(74,163,255,0.45); background: rgba(74,163,255,0.12); }
.wz-pill-dbsync { color: #2dd4bf; border-color: rgba(45,212,191,0.45); background: rgba(45,212,191,0.12); }
.wz-pill-bf { color: #a78bfa; border-color: rgba(167,139,250,0.45); background: rgba(167,139,250,0.12); }

.wz-cards { display: flex; flex-direction: column; gap: 10px; }
.wz-cards-row { flex-direction: row; }
.wz-card { text-align: left; cursor: pointer; border-radius: 10px; padding: 14px 16px; flex: 1;
  background: rgba(120,150,190,0.05); border: 1.5px solid rgba(120,150,190,0.22); color: inherit;
  transition: border-color .15s, background .15s, transform .1s; }
.wz-card:hover { border-color: rgba(120,150,190,0.5); }
.wz-card:active { transform: scale(.99); }
.wz-card-sm { text-align: center; padding: 16px; }
.wz-card-on { border-color: var(--pt-accent-blue, #4aa3ff); background: rgba(74,163,255,0.12); }
.wz-card-h { font-size: 14px; font-weight: 700; color: var(--pt-text-primary, #e6edf3); margin-bottom: 3px; }
.wz-card-d { font-size: 12.5px; color: var(--pt-text-secondary, #b9c4d0); line-height: 1.5; }

/* hub source grid */
.wz-srcgrid { display: flex; flex-direction: column; gap: 9px; margin: 4px 0 2px; }
.wz-srccard { position: relative; border-radius: 10px; padding: 12px 14px; border: 1px solid rgba(120,150,190,0.2);
  background: rgba(120,150,190,0.04); }
.wz-srccard-t { font-size: 12px; color: var(--pt-text-secondary, #b9c4d0); line-height: 1.45; margin-top: 6px; }
.wz-srccard-tag { position: absolute; top: 12px; right: 13px; font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
  font-weight: 700; color: #4ade80; }
.wz-srccard-tag.wz-tag-opt { color: var(--pt-text-muted, #9aa7b4); }
.wz-koios-card { border-color: rgba(74,163,255,0.3); }
.wz-dbsync-card { border-color: rgba(45,212,191,0.22); }
.wz-bf-card { border-color: rgba(167,139,250,0.22); }

/* reveal animation for Yes -> fields */
.wz-reveal { max-height: 0; overflow: hidden; opacity: 0; transition: max-height .3s ease, opacity .25s ease, margin .25s ease; margin: 0; }
.wz-reveal-open { max-height: 600px; opacity: 1; margin: 14px 0 0; }
.wz-creds { transition: max-height .25s ease, opacity .2s ease; overflow: hidden; }
.wz-creds-hidden { max-height: 0; opacity: 0; }

.wz-field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 10px; }
.wz-field > label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--pt-text-muted, #9aa7b4); }
.wz-row { display: flex; gap: 10px; }
.wz-row .wz-field { flex: 1; }
.wz-opt { text-transform: none; letter-spacing: 0; opacity: .7; font-size: 11px; }
.wz-check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--pt-text-secondary, #b9c4d0); margin: 4px 0 8px; cursor: pointer; text-transform: none; letter-spacing: 0; }
.wz-hint { font-size: 11.5px; color: var(--pt-text-muted, #9aa7b4); line-height: 1.5; margin-top: 2px; }
.wz-hint.wz-warn { color: #fb7185; }
.wz-ok { font-size: 15px; font-weight: 700; color: #4ade80; margin-bottom: 10px; }
.wz-testrow { display: flex; align-items: center; gap: 11px; margin-top: 10px; flex-wrap: wrap; }
.wz-test-result { font-size: 12.5px; font-weight: 600; }
.wz-test-pending { color: var(--pt-text-muted, #9aa7b4); }
.wz-test-good { color: #4ade80; }
.wz-test-bad { color: #fb7185; }

.wz-base { display: flex; align-items: center; gap: 11px; margin: 0 0 14px; padding: 11px 13px;
  border-radius: 9px; background: rgba(74,163,255,0.07); border: 1px solid rgba(74,163,255,0.2); flex-wrap: wrap; }
.wz-base-node { background: rgba(74,222,128,0.06); border-color: rgba(74,222,128,0.22); }
.wz-base-t { font-size: 12.5px; color: var(--pt-text-secondary, #b9c4d0); line-height: 1.5; flex: 1; min-width: 220px; }

.wz-summary { margin: 10px 0 0; border: 1px solid rgba(120,150,190,0.2); border-radius: 8px; overflow: hidden; }
.wz-sum-row { display: flex; justify-content: space-between; padding: 9px 13px; font-size: 13px; border-top: 1px solid rgba(120,150,190,0.12); }
.wz-sum-row:first-child { border-top: 0; }
.wz-sum-k { color: var(--pt-text-muted, #9aa7b4); text-transform: uppercase; font-size: 11px; letter-spacing: .05em; }
.wz-sum-v { color: var(--pt-text-primary, #e6edf3); font-weight: 600; }
.wz-sumchips { display: flex; gap: 7px; flex-wrap: wrap; margin: 2px 0 4px; }
.wz-err { color: #fb7185; font-size: 12.5px; margin-top: 10px; min-height: 16px; }

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
.wz-hero { text-align: center; padding: 8px 0 2px; }
.wz-hero-mark { width: 54px; height: 54px; border-radius: 12px; margin: 0 auto 14px; display: flex; align-items: center; justify-content: center;
  background: rgba(74,163,255,0.12); border: 1px solid rgba(74,163,255,0.4); }
.wz-hero-icon { color: #7BB0F5; font: 700 15px ui-monospace, monospace; letter-spacing: 1px; }
.wz-hero-title { font-size: 19px; font-weight: 700; color: var(--pt-text-primary, #e6edf3); }
.wz-hero-sub { font-size: 13px; color: var(--pt-text-muted, #9aa7b4); line-height: 1.55; max-width: 380px; margin: 8px auto 0; }
.wz-demo-row { text-align: center; margin-top: 16px; }
.wz-demo-btn { background: transparent; border: 0; color: var(--pt-accent-blue, #4aa3ff); font-size: 12.5px; cursor: pointer; text-decoration: underline; padding: 4px; }
.wz-demo-btn:hover { color: #7bb0f5; }
/* consistent styling foundation /*wz-style-v39*/ */
.wz-body { padding: 8px 2px 6px; }
.wz-lead-row { display: flex; gap: 11px; align-items: flex-start; margin: 2px 0 16px; }
.wz-mark { flex: 0 0 auto; width: 30px; height: 30px; border-radius: 7px; background: rgba(74,163,255,0.12); border: 1px solid #33507a; display: flex; align-items: center; justify-content: center; color: #7bb0f5; }
.wz-lead-t { font-size: 12.5px; color: var(--pt-text-secondary, #b9c4d0); line-height: 1.5; padding-top: 4px; }
.wz-card-ico { display: flex; align-items: center; gap: 13px; text-align: left; }
.wz-card-ico .wz-card-ic { flex: 0 0 auto; width: 34px; height: 34px; border-radius: 8px; background: rgba(74,163,255,0.10); border: 1px solid #33507a; display: flex; align-items: center; justify-content: center; color: #7bb0f5; }
.wz-card-ico.wz-card-on .wz-card-ic { background: rgba(74,163,255,0.2); border-color: var(--pt-accent-blue, #4aa3ff); }
.wz-card-body { display: flex; flex-direction: column; min-width: 0; gap: 2px; }
#wz-next:disabled { opacity: .4; cursor: not-allowed; }
.wz-row { display: flex; gap: 10px; }
.wz-field { margin-bottom: 13px; }
`;

export function showSetupWizard(opts = {}) {
  if (document.getElementById('wz-modal')) return;
  const onComplete = typeof opts.onComplete === 'function' ? opts.onComplete : null;
  const wiz = Object.assign(freshState(), opts._resume || {});
  // If a live session already exists (e.g. re-running the wizard from the
  // running app), pre-fill the connect step from it so we don't force a
  // needless reconnect/2FA. POOL_ID is already captured in the session.
  if (!wiz._connected && isConnected()) {
    wiz._connected = true;
    const _sess = getSession();
    wiz.poolHex = wiz.poolHex || (_sess && _sess.envVars && _sess.envVars.POOL_ID) || null;
  }
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
    // Wrap content in a fresh node so the entrance animation re-triggers each step.
    $('#wz-body').innerHTML = `<div class="wz-anim">${step.render(wiz)}</div>`;
    $('#wz-err').textContent = '';

    $('#wz-progress').innerHTML =
      STEPS.map((_, i) => `<span class="wz-dot ${i === idx ? 'wz-dot-on' : i < idx ? 'wz-dot-done' : ''}"></span>`).join('') +
      `<span class="wz-step-count">Step ${idx + 1} of ${STEPS.length}</span>`;

    const _connectIdx = STEPS.findIndex((s) => s.key === 'connect');
    const _backLocked = idx === 0 || (wiz._connected && idx <= _connectIdx + 1);
    $('#wz-back').style.visibility = _backLocked ? 'hidden' : 'visible';
    $('#wz-next').textContent = idx === STEPS.length - 1 ? 'Finish' : 'Next';
    $('#wz-next').style.display = (step.key === 'transport') ? 'none' : '';   /*wz-next-hide-v36*/
    refreshNext();   /*wz-next-gate-v41*/

    if (step.key === 'connect') {
      const btn = modal.querySelector('#wz-connect-btn');
      if (btn) btn.addEventListener('click', () => {
        // Hand off to the existing connection screen (kept unforked). On a live
        // connect, capture the pool hex (POOL_ID) for db-sync init, then resume
        // the wizard at the hub step carrying all choices so far.
        const saved = { ...wiz };
        const hubIdx = STEPS.findIndex((s) => s.key === 'koios');
        modal.remove();
        showConnectModal((res) => {
          if (res && res.mode === 'live') {
            saved._connected = true;
            saved.poolHex = (res.envVars && res.envVars.POOL_ID) || null;
            showSetupWizard({ onComplete, _resume: saved, _startIndex: hubIdx });
          } else {
            const connectStepIdx = STEPS.findIndex((s) => s.key === 'connect');   /*wz-back-v38*/
            showSetupWizard({ onComplete, _resume: saved, _startIndex: connectStepIdx });
          }
        }, { showBack: true });
      });
    }

    if (step.key === 'welcome') {
      const d = modal.querySelector('#wz-demo');
      if (d) d.addEventListener('click', () => {   /*wz-demo-welcome-v37*/
        setMode('demo');
        modal.remove();
        if (onComplete) onComplete(wiz);
      });
    }

    if (step.key === 'transport') {
      modal.querySelectorAll('.wz-card').forEach((card) => {
        card.addEventListener('click', () => {
          wiz.transport = card.dataset.choice;
          modal.querySelectorAll('.wz-card').forEach((c) => c.classList.toggle('wz-card-on', c === card));
          $('#wz-err').textContent = '';
          setTimeout(() => { const nb = $('#wz-next'); if (nb) nb.click(); }, 180);   // auto-advance /*wz-flow-v35*/
        });
      });
    }

    if (step.key === 'koios') {
      const reveal = modal.querySelector('#wz-koios-fields');
      modal.querySelectorAll('.wz-card[data-koios]').forEach((card) => {
        card.addEventListener('click', () => {
          wiz.koiosMode = card.dataset.koios;
          modal.querySelectorAll('.wz-card[data-koios]').forEach((c) => c.classList.toggle('wz-card-on', c === card));
          if (reveal) reveal.classList.toggle('wz-reveal-open', wiz.koiosMode === 'key');
          $('#wz-err').textContent = '';
          if (wiz.koiosMode === 'key') { const t = modal.querySelector('#wz-koios-token'); if (t) t.focus(); }
        });
      });
    }

    if (step.key === 'dbsync') {
      const reveal = modal.querySelector('#wz-dbsync-fields');
      modal.querySelectorAll('.wz-card[data-yn]').forEach((card) => {
        card.addEventListener('click', () => {
          const yes = card.dataset.yn === 'yes';
          wiz.useDbsync = yes; wiz._dbAnswered = true;
          modal.querySelectorAll('.wz-card[data-yn]').forEach((c) => c.classList.toggle('wz-card-on', c === card));
          if (reveal) reveal.classList.toggle('wz-reveal-open', yes);
          $('#wz-err').textContent = '';
          updateDbHint();
        });
      });
      const modeEl = modal.querySelector('#wz-db-mode');
      if (modeEl) modeEl.addEventListener('change', () => {
        const creds = modal.querySelector('#wz-db-creds');
        const local = modeEl.value === 'local';
        if (creds) creds.classList.toggle('wz-creds-hidden', local);
        const hostEl = modal.querySelector('#wz-db-host');
        if (hostEl && modeEl.value === 'tunnel' && !hostEl.value) hostEl.value = '127.0.0.1';
        updateDbHint();
      });
      function updateDbHint() {
        const h = modal.querySelector('#wz-db-hint'); if (!h) return;
        const m = (modal.querySelector('#wz-db-mode') || {}).value || 'local';
        h.textContent = m === 'local'
          ? 'Local socket: db-sync runs on this same machine. Leave the credentials as they are - it connects through the socket. db-sync activates after a successful test.'
          : m === 'tunnel'
            ? 'Tunnel: PoolTerminal reaches db-sync through the SSH connection to your node. Host is as the node sees it (usually 127.0.0.1).'
            : 'Network: enter the host, port and user for the machine running db-sync.';
      }
      updateDbHint();

      const dbTest = modal.querySelector('#wz-db-test');
      if (dbTest) dbTest.addEventListener('click', async () => {
        const res = modal.querySelector('#wz-db-test-result');
        if (!res) return;
        if (!wiz.poolHex) {
          res.textContent = 'Connect to your node first (needed to find your pool).';
          res.className = 'wz-test-result wz-test-bad'; return;
        }
        const modeEl = modal.querySelector('#wz-db-mode');
        const v = (id) => { const el = modal.querySelector(id); return el ? el.value.trim() : ''; };
        const tmp = {
          dbsyncMode: modeEl ? modeEl.value : 'local',
          dbsync: {
            database: v('#wz-db-name') || 'cexplorer',
            host: v('#wz-db-host'), port: Number(v('#wz-db-port')) || 5432,
            user: v('#wz-db-user'), password: v('#wz-db-pass'),
          },
        };
        res.textContent = 'Testing...'; res.className = 'wz-test-result wz-test-pending';
        dbTest.disabled = true;
        try {
          const ok = await initDbsync(buildDbsyncConfig(tmp), wiz.poolHex);
          res.textContent = ok ? 'Connected to db-sync \u2713' : 'Could not connect - check the details above.';
          res.className = 'wz-test-result ' + (ok ? 'wz-test-good' : 'wz-test-bad');
        } catch (e) {
          res.textContent = 'Connection failed: ' + (e.message ?? e);
          res.className = 'wz-test-result wz-test-bad';
        } finally { dbTest.disabled = false; }
      });
    }

    if (step.key === 'blockfrost') {
      const reveal = modal.querySelector('#wz-bf-fields');
      modal.querySelectorAll('.wz-card[data-yn]').forEach((card) => {
        card.addEventListener('click', () => {
          const yes = card.dataset.yn === 'yes';
          wiz.useBlockfrost = yes; wiz._bfAnswered = true;
          modal.querySelectorAll('.wz-card[data-yn]').forEach((c) => c.classList.toggle('wz-card-on', c === card));
          if (reveal) reveal.classList.toggle('wz-reveal-open', yes);
          $('#wz-err').textContent = '';
        });
      });
      const bfTest = modal.querySelector('#wz-bf-test');
      if (bfTest) bfTest.addEventListener('click', async () => {
        const res = modal.querySelector('#wz-bf-test-result');
        if (!res) return;
        const key = ((modal.querySelector('#wz-bf-key') || {}).value || '').trim();
        if (!key) { res.textContent = 'Enter a key first.'; res.className = 'wz-test-result wz-test-bad'; return; }
        res.textContent = 'Testing...'; res.className = 'wz-test-result wz-test-pending';
        bfTest.disabled = true;
        try {
          const ok = await applyBlockfrostKey(key);
          res.textContent = ok ? 'Key valid, Blockfrost reachable \u2713' : 'Key set but not reachable - check it.';
          res.className = 'wz-test-result ' + (ok ? 'wz-test-good' : 'wz-test-bad');
        } catch (e) {
          res.textContent = 'Test failed: ' + (e.message ?? e);
          res.className = 'wz-test-result wz-test-bad';
        } finally { bfTest.disabled = false; }
      });
    }

    if (step.key === 'notif') {
      const recompute = () => {
        const tier = (wiz.koiosToken || '').trim() ? 'token' : 'free';
        const intEl = modal.querySelector('#wz-n-interval');
        const intervalMs = intEl ? Number(intEl.value) : getNotifSettings().pollMs;
        const source = wiz.useDbsync ? 'dbsync' : (wiz.useBlockfrost ? 'blockfrost' : 'koios');
        const srcName = source === 'dbsync' ? 'db-sync' : source === 'blockfrost' ? 'Blockfrost' : 'Koios';
        const count = wiz._delegCount || 0;
        const sug = suggestPollMs({ delegatorCount: count, source, koiosTier: tier });
        const reasonEl = modal.querySelector('#wz-n-reason');
        if (reasonEl) {
          if (source === 'dbsync') {
            reasonEl.textContent = sug.reason;   // unlimited - independent of delegator count
          } else {
            reasonEl.textContent = count > 0
              ? `Suggested ${fmtInterval(sug.ms)} - ${sug.reason}`
              : `Suggested ${fmtInterval(sug.ms)} as a safe starting point. This fine-tunes once connected, since it depends on your delegator count.`;
          }
        }
        const sBtn = modal.querySelector('#wz-n-suggest');
        if (sBtn) sBtn.dataset.ms = String(sug.ms);
        const usageEl = modal.querySelector('#wz-n-usage');
        if (usageEl) {
          if (source === 'dbsync') {
            usageEl.textContent = 'db-sync reads your own database - no API budget to worry about.';
            usageEl.classList.remove('wz-warn');
          } else if (count > 0) {
            const u = pollUsage({ ms: intervalMs, delegatorCount: count, source, koiosTier: tier });
            let t = `At ${fmtInterval(intervalMs)}: ~${u.callsPerDay.toLocaleString()} ${srcName} calls/day of ${u.budget.toLocaleString()} allowed.`;
            if (u.breaches) t += source === 'koios'
              ? ' Over budget - choose a longer interval, or use a registered token.'
              : ' Over budget - choose a longer interval, or use db-sync for unlimited live updates.';
            usageEl.textContent = t; usageEl.classList.toggle('wz-warn', u.breaches);
          } else { usageEl.textContent = ''; usageEl.classList.remove('wz-warn'); }
        }
      };
      ['#wz-n-interval'].forEach((id) => { const el = modal.querySelector(id); if (el) el.addEventListener('change', recompute); });
      const sg = modal.querySelector('#wz-n-suggest');
      if (sg) sg.addEventListener('click', () => {
        const ms = Number(sg.dataset.ms); const sel = modal.querySelector('#wz-n-interval');
        if (ms && sel) { sel.value = String(ms); recompute(); }
      });
      recompute();
    }
  }

  $('#wz-back').addEventListener('click', () => {
    const connectIdx = STEPS.findIndex((s) => s.key === 'connect');
    if (wiz._connected && idx <= connectIdx + 1) return;   // node connection is a commitment
    if (idx > 0) { idx--; paint(); }
  });
  // Gate Next on the step's own validation; re-check whenever the user acts.
  function refreshNext() {
    const st = STEPS[idx];
    const nb = $('#wz-next');
    if (!nb) return;
    const invalid = st.validate ? !!st.validate(wiz, modal) : false;
    nb.disabled = invalid;
  }
  modal.addEventListener('input', refreshNext);
  modal.addEventListener('click', () => setTimeout(refreshNext, 0));

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
    out.dbsyncMode = wiz.dbsyncMode || 'local';
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

/** Map the wizard db-sync inputs to an initDbsync config. Mode decides shape:
 *  local = socket (no host); tcp = direct network; tunnel = over SSH (viaSsh). */
function buildDbsyncConfig(wiz) {
  const d = wiz.dbsync || {};
  const mode = wiz.dbsyncMode || 'local';
  const cfg = { database: d.database || 'cexplorer' };
  if (mode === 'local') return cfg;
  cfg.host = d.host || (mode === 'tunnel' ? '127.0.0.1' : '');
  cfg.port = d.port || 5432;
  if (d.user) cfg.user = d.user;
  if (d.password) cfg.password = d.password;
  if (mode === 'tunnel') cfg.viaSsh = true;   // honoured only when SSH_TUNNEL_ENABLED
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

  try {
    setKoiosToken(wiz.koiosToken || '');
    if ((wiz.koiosToken || '').trim()) setPaused(false);   // token raises the daily limit; lift any free-tier auto-pause
  } catch (e) { console.warn('[wizard] Koios token save failed:', e.message ?? e); }

  if (wiz.useDbsync && wiz.poolHex) {
    try {
      const ok = await initDbsync(buildDbsyncConfig(wiz), wiz.poolHex);
      console.log(ok ? '[wizard] db-sync activated' : '[wizard] db-sync not reachable - Koios still serves history');
    } catch (e) { console.warn('[wizard] db-sync init failed:', e.message ?? e); }
  }

  if (wiz.useBlockfrost && wiz.blockfrostKey) {
    try {
      const ok = await applyBlockfrostKey(wiz.blockfrostKey);
      console.log(ok ? '[wizard] Blockfrost activated' : '[wizard] Blockfrost key set but not reachable - check the key');
    } catch (e) { console.warn('[wizard] Blockfrost init failed:', e.message ?? e); }
  }
}
