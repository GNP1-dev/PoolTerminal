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
    key: 'dbhave',
    title: 'Do you run db-sync?',
    accent: 'dbsync',
    render: (wiz) => {
      const yn = wiz._dbAnswered ? !!wiz.useDbsync : null;
      return `
      ${wzHead(ICON_DB, "<span class='wz-src wz-dbsync'>db-sync</span> is your own full copy of the Cardano database. If you run one, PoolTerminal reads it directly - adding the <strong>loyalty leaderboard</strong>, full instant history and the delegator deep-dive, with no API limits.")}
      ${yesNoCards(null, yn)}
      <div class="wz-foot">Not sure? Choose No - Koios covers history and the deep-dive. You can add db-sync later.</div>`;
    },
    validate: (wiz) => (wiz._dbAnswered ? null : 'Please choose Yes or No.'),
  },
  {
    key: 'dbwhere',   /*wz-dbtree-v62*/
    title: 'Where does db-sync run?',
    accent: 'dbsync',
    skip: (wiz) => !wiz.useDbsync,
    render: (wiz) => {
      const loc = wiz.dbLocation || null;
      const card = (id, ico, title, sub) =>
        `<button class="wz-card wz-card-ico ${loc === id ? 'wz-card-on' : ''}" data-dbloc="${id}" type="button">`
        + `<span class="wz-card-ic">${ico}</span><span class="wz-card-body"><span class="wz-card-h">${title}</span>`
        + `<span class="wz-card-d">${sub}</span></span></button>`;
      return `
      ${wzHead(ICON_DB, "Where is the machine running db-sync, relative to PoolTerminal and your node?")}
      <div class="wz-cards">
        ${card('local', ICON_DESKTOP, 'On this machine', 'db-sync is on the same computer as PoolTerminal. Connects through the local socket - no SSH needed.')}
        ${card('bp', ICON_NETWORK, 'On your block producer', 'db-sync lives on the node you are connecting to. Reuses that SSH connection - no extra login.')}
        ${card('remote', ICON_NETWORK, 'On another machine', 'db-sync is on a separate machine. PoolTerminal opens its own SSH connection to it.')}
      </div>`;
    },
    validate: (wiz) => (wiz.dbLocation ? null : 'Please choose where db-sync runs.'),
  },
  {
    key: 'dbkey',   /*wz-guided-key-v69*/
    title: 'SSH key for db-sync',
    accent: 'dbsync',
    skip: (wiz) => !(wiz.useDbsync && wiz.dbLocation === 'remote' && wizardGuided()),
    render: (wiz) => {
      const KI = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2m-4 2 2.5 2.5M14 5l2.5 2.5"/></svg>';
      const mode = wiz._keyMode || '';
      const kp = wiz.sshKeyPath || '';
      const card = (id, title, sub) =>
        `<button class="wz-card wz-card-ico ${mode === id ? 'wz-card-on' : ''}" data-keymode="${id}" type="button">`
        + `<span class="wz-card-ic">${KI}</span><span class="wz-card-body"><span class="wz-card-h">${title}</span>`
        + `<span class="wz-card-d">${sub}</span></span></button>`;
      const genBlock = `
          ${mode === 'walk' ? '<div class="wz-subhead">Step 1 — create the key on this machine</div>' : ''}
          <div class="wz-genrow">
            <button type="button" class="pt-btn" id="wz-key-gen">Generate key</button>
            <span class="wz-test-result" id="wz-key-gen-result"></span>
          </div>
          ${mode === 'walk' ? `<div class="wz-info">Prefer to run it yourself? This is the exact command:</div>
          <div class="wz-info-cmd"><code>ssh-keygen -t ed25519 -f ~/.ssh/pt_dbsync -N ''</code><button type="button" class="wz-info-copy" data-copy="ssh-keygen -t ed25519 -f ~/.ssh/pt_dbsync -N ''">copy</button></div>` : ''}
          <div class="wz-field"><label>Private key path <span class="wz-opt">(on this machine)</span></label>
            <input id="wz-key-path" type="text" value="${esc(kp)}" placeholder="(fills in after you generate)" autocomplete="off"></div>
          <div class="wz-reveal" id="wz-key-authorise">
            ${mode === 'walk'
              ? '<div class="wz-subhead">Step 2 — authorise it on the db-sync machine</div><div class="wz-info">The key has two halves. The private half stays here; the public half below must be added to the db-sync machine so it recognises this computer. Run these <strong>on the db-sync machine</strong>:</div>'
              : '<div class="wz-info">Now authorise this key on the db-sync machine — copy the public key and run these <strong>on that machine</strong>:</div>'}
            <div class="wz-info-cmd"><code id="wz-key-pub">(generate first)</code><button type="button" class="wz-info-copy" id="wz-key-pub-copy">copy</button></div>
            <div class="wz-info-cmd"><code>cat ~/.ssh/authorized_keys 2&gt;/dev/null; echo 'PASTE_PUBLIC_KEY' &gt;&gt; ~/.ssh/authorized_keys</code><button type="button" class="wz-info-copy" data-copy="echo 'PASTE_THE_PUBLIC_KEY_HERE' >> ~/.ssh/authorized_keys">copy</button></div>
            <div class="wz-info-cmd"><code>chmod 700 ~/.ssh &amp;&amp; chmod 600 ~/.ssh/authorized_keys</code><button type="button" class="wz-info-copy" data-copy="chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys">copy</button></div>
            ${mode === 'walk' ? '<div class="wz-info">That permissions step matters: if <code>~/.ssh</code> is left too open, SSH silently ignores the key and falls back to asking for a password.</div>' : ''}
          </div>`;
      return `
      ${wzHead(ICON_DB, "PoolTerminal signs in to the db-sync machine with an <strong>SSH key</strong> rather than a password, because it reconnects on its own in the background and can't type a password or 2FA code each time. How would you like to sort the key out?")}
      <div class="wz-cards">
        ${card('have', 'I already have a key', 'Point PoolTerminal at an existing private key on this machine.')}
        ${card('gen', 'Generate one for me', 'Create a dedicated key on this machine, ready to authorise on the db-sync host.')}
        ${card('walk', 'Walk me through it', 'The same as generate, with each step explained — what the key is for and how to authorise it.')}
      </div>
      <div class="wz-reveal ${mode ? 'wz-reveal-open' : ''}" id="wz-key-reveal">
        ${mode === 'have' ? `
          <div class="wz-field"><label>Path to your private key <span class="wz-opt">(on this machine)</span></label>
            <input id="wz-key-path" type="text" value="${esc(kp)}" placeholder="/home/you/.ssh/id_ed25519" autocomplete="off"></div>
          <div class="wz-info">Make sure this key's public half (the <code>.pub</code>) is already in <code>~/.ssh/authorized_keys</code> on the db-sync machine, with <code>~/.ssh</code> at <code>700</code> and <code>authorized_keys</code> at <code>600</code> there.</div>
        ` : ''}
        ${(mode === 'gen' || mode === 'walk') ? genBlock : ''}
      </div>
      <div class="wz-foot">Experienced operators can pick "I already have a key" and just enter the path.</div>`;
    },
    collect: (wiz, root) => {
      const el = root.querySelector('#wz-key-path');
      if (el) wiz.sshKeyPath = el.value.trim();
    },
    validate: (wiz, root) => {
      if (!(wiz.useDbsync && wiz.dbLocation === 'remote' && wizardGuided())) return null;
      if (!wiz._keyMode) return 'Choose how to set up the SSH key.';
      const el = root && root.querySelector('#wz-key-path');
      const v = el ? el.value.trim() : '';
      return v ? null : 'Generate or enter the SSH key path to continue.';
    },
  },
  {
    key: 'dbconn',
    title: 'db-sync connection',
    accent: 'dbsync',
    skip: (wiz) => !wiz.useDbsync,
    render: (wiz) => {
      const loc = wiz.dbLocation || 'local';
      const db = wiz.dbsync || {};
      const ssh = db.ssh || {};
      const authMode = db.authMode || 'password';
      const dbNameRole = `
        <div class="wz-field"><label>Database name</label>
          <input id="wz-db-name" type="text" value="${esc(db.database || 'cexplorer')}" autocomplete="off"></div>
        <div class="wz-field"><label>Database role / user</label>
          <input id="wz-db-user" type="text" value="${esc(db.user || '')}" placeholder="e.g. cexplorer or your linux user" autocomplete="off"></div>`;
      const discover = `<div class="wz-info">Not sure of the names? On the db-sync machine run <code>sudo -u postgres psql -l</code> to list the databases and their owning role.</div>`;

      if (loc === 'local') {
        return `
        ${wzHead(ICON_DB, "db-sync is on this machine. PoolTerminal connects through the local socket - just confirm the database name and role.")}
        ${dbNameRole}
        ${discover}
        <div class="wz-hint" id="wz-db-hint"></div>
        <div class="wz-testrow"><button class="pt-btn" id="wz-db-test" type="button">Test connection</button><span class="wz-test-result" id="wz-db-test-result"></span></div>`;
      }

      // Shared db-access prerequisites - shown on BOTH the BP and remote paths,
      // because either way db-sync lives on another machine that must be set up.
      const prereq = `
        <div class="wz-note wz-note-warn">
          <div class="wz-note-h">On the db-sync machine you will need:</div>
          <ul class="wz-checklist">
            <li>Postgres reachable on <strong>localhost</strong> - <code>ss -tlnp | grep 5432</code> should show <code>127.0.0.1:5432</code>. <button type="button" class="wz-info-i" data-info="pglocal">i</button></li>
            <li>A way in for the database: a <strong>password</strong> for the role, or a <strong>loopback-trust</strong> line in <code>pg_hba.conf</code> (<code>host &lt;db&gt; &lt;role&gt; 127.0.0.1/32 trust</code>) - safe only while Postgres stays localhost-only. <button type="button" class="wz-info-i" data-info="pgauth">i</button></li>
            <li>Your <strong>database and role names</strong> - run <code>sudo -u postgres psql -l</code> to see them. <button type="button" class="wz-info-i" data-info="dbnames">i</button></li>
          </ul>
        </div>`;

      const pgHostPort = `
        <div class="wz-row">
          <div class="wz-field"><label>db-sync host <span class="wz-opt">(as seen ON that machine - usually 127.0.0.1)</span></label>
            <input id="wz-db-host" type="text" value="${esc(db.host || '127.0.0.1')}" autocomplete="off"></div>
          <div class="wz-field" style="flex:0.45"><label>Port</label>
            <input id="wz-db-port" type="number" value="${db.port || 5432}" autocomplete="off"></div>
        </div>`;

      const auth = `
        <div class="wz-field"><label>Database access</label>
          <input type="hidden" id="wz-db-auth" value="${authMode}">
          <div class="wz-seg" id="wz-db-auth-seg">
            <button type="button" class="wz-seg-btn ${authMode === 'password' ? 'wz-seg-on' : ''}" data-auth="password">Password (simplest)</button>
            <button type="button" class="wz-seg-btn ${authMode === 'trust' ? 'wz-seg-on' : ''}" data-auth="trust">No password - loopback trust</button>
          </div>
        </div>
        <div class="wz-field ${authMode === 'password' ? '' : 'wz-creds-hidden'}" id="wz-db-passrow"><label>Database password</label>
          <input id="wz-db-pass" type="password" value="${esc(db.password || '')}" autocomplete="off">
          <label class="wz-check"><input type="checkbox" id="wz-db-savepass"${db.savePassword ? ' checked' : ''}> Remember this password on this machine</label></div>
        <div class="wz-info ${authMode === 'trust' ? '' : 'wz-creds-hidden'}" id="wz-db-trustnote">Loopback trust means no password is stored: access is controlled purely by who can open the SSH tunnel. Keep Postgres listening on localhost only.</div>`;

      if (loc === 'bp') {
        return `
        ${wzHead(ICON_DB, "db-sync is on your block producer. PoolTerminal reaches it through the SSH connection you already set up - no extra login. You still need the database reachable and authorised on that machine:")}
        ${prereq}
        ${pgHostPort}
        ${dbNameRole}
        ${auth}
        <div class="wz-info">This rides your node's SSH session (your 2FA login), and reconnects when you reconnect to the node.</div>
        <div class="wz-testrow"><button class="pt-btn" id="wz-db-test" type="button">Test connection</button><span class="wz-test-result" id="wz-db-test-result"></span></div>`;
      }

      // remote (another machine): full SSH panel
      return `
      ${wzHead(ICON_DB, "db-sync is on a separate machine. PoolTerminal opens its <strong>own SSH connection</strong> to it and reads the database through the tunnel - nothing is exposed to the network.")}
      <div class="wz-note wz-note-warn">
        <div class="wz-note-h">SSH access (key-based): <button type="button" class="wz-info-i" data-info="sshkey">i</button></div>
        <ul class="wz-checklist">
          <li>A password/2FA login will not work for a background connection - use an <strong>SSH key</strong>. Add its <code>.pub</code> to <code>~/.ssh/authorized_keys</code> on the db-sync machine.</li>
          <li><strong>Permissions matter (fails silently):</strong> <code>~/.ssh</code> must be <code>700</code> and <code>authorized_keys</code> <code>600</code>, or SSH ignores the key and falls back to a password prompt.</li>
        </ul>
      </div>
      ${prereq}
      <div class="wz-subhead">SSH to the db-sync machine</div>
      <div class="wz-row">
        <div class="wz-field"><label>SSH host</label><input id="wz-ssh-host" type="text" value="${esc(ssh.host || '')}" placeholder="192.168.0.x or hostname" autocomplete="off"></div>
        <div class="wz-field" style="flex:0.4"><label>Port</label><input id="wz-ssh-port" type="number" value="${ssh.port || 22}" autocomplete="off"></div>
      </div>
      <div class="wz-field"><label>SSH username</label><input id="wz-ssh-user" type="text" value="${esc(ssh.username || '')}" autocomplete="off"></div>
      <div class="wz-field"><label>SSH private key path <span class="wz-opt">(on this machine)</span></label><input id="wz-ssh-key" type="text" value="${esc(wiz.sshKeyPath || (ssh.auth && ssh.auth.path) || '')}" placeholder="/home/you/.ssh/id_ed25519" autocomplete="off"></div>
      <div class="wz-field"><label>Key passphrase <span class="wz-opt">(only if your key has one)</span></label><input id="wz-ssh-pass" type="password" value="${esc((ssh.auth && ssh.auth.passphrase) || '')}" autocomplete="off"></div>
      <div class="wz-subhead">Database on that machine</div>
      ${pgHostPort}
      ${dbNameRole}
      ${auth}
      <div class="wz-testrow"><button class="pt-btn" id="wz-db-test" type="button">Test connection</button><span class="wz-test-result" id="wz-db-test-result"></span></div>`;
    },
    collect: (wiz, root) => {
      if (!wiz.useDbsync) return;
      const loc = wiz.dbLocation || 'local';
      const v = (id) => { const el = root.querySelector(id); return el ? el.value.trim() : ''; };
      const chk = (id) => { const el = root.querySelector(id); return !!(el && el.checked); };
      wiz.dbsyncMode = loc === 'local' ? 'local' : loc === 'bp' ? 'tunnel' : 'ssh';
      const authEl = root.querySelector('#wz-db-auth');
      const authMode = authEl ? authEl.value : 'password';
      const cfg = {
        database: v('#wz-db-name') || 'cexplorer',
        user: v('#wz-db-user'),
        host: v('#wz-db-host') || (loc === 'local' ? '' : '127.0.0.1'),
        port: Number(v('#wz-db-port')) || 5432,
        authMode,
        password: authMode === 'password' ? v('#wz-db-pass') : '',
        savePassword: authMode === 'password' ? chk('#wz-db-savepass') : false,
      };
      if (loc === 'remote') {
        cfg.ssh = {
          host: v('#wz-ssh-host'),
          port: Number(v('#wz-ssh-port')) || 22,
          username: v('#wz-ssh-user'),
          auth: { type: 'key', path: v('#wz-ssh-key'), passphrase: v('#wz-ssh-pass') || null },
        };
      }
      wiz.dbsync = cfg;
    },
    validate: (wiz, root) => {   /*wz-dbconn-validate-v63a2*/
      if (!wiz.useDbsync) return null;
      const loc = wiz.dbLocation || 'local';
      const v = (id) => { const el = root && root.querySelector(id); return el ? el.value.trim() : ''; };
      if (!v('#wz-db-name')) return 'Enter the database name.';
      if (loc === 'remote') {
        if (!v('#wz-ssh-host')) return 'Enter the SSH host of the db-sync machine.';
        if (!v('#wz-ssh-user')) return 'Enter the SSH username.';
        if (!v('#wz-ssh-key')) return 'Enter the SSH private key path.';
      }
      return null;
    },
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
.wz-creds-hidden { max-height: 0; opacity: 0; overflow: hidden; pointer-events: none; }  /*wz-collapse-fix-v63a3*/

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
/* segmented toggle - native-select-free (wz-authseg-v63a4) */
.wz-seg { display:flex; gap:6px; }
.wz-seg-btn { flex:1; padding:8px 10px; border-radius:5px; cursor:pointer; font:600 12px ui-monospace, monospace; text-align:center; background:#0e1620; border:1px solid rgba(120,150,190,.5); color:#9fb4cc; }
.wz-seg-btn:hover { border-color:rgba(120,150,190,.85); }
.wz-seg-btn.wz-seg-on { background:rgba(54,224,212,.16); border-color:rgba(54,224,212,.6); color:#8ff2e6; }
.wz-genrow { display:flex; align-items:center; gap:12px; margin:8px 0 10px; }   /*wz-guided-key-v69*/
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
/* db-sync tree panels (wz-dbtree-v62) */
.wz-note-warn { background: rgba(255,196,74,0.08); border: 1px solid rgba(255,196,74,0.35); border-radius: 8px; padding: 10px 12px; margin: 4px 0 12px; }
.wz-note-h { font-weight: 700; font-size: 12px; color: #ffcf5a; margin-bottom: 6px; }
.wz-checklist { margin: 0; padding-left: 18px; font-size: 11.5px; color: var(--pt-text-secondary, #b9c4d0); line-height: 1.6; }
.wz-checklist li { margin-bottom: 4px; }
.wz-checklist code, .wz-info code { background: rgba(120,150,200,0.14); border-radius: 3px; padding: 1px 4px; font-size: 10.5px; }
.wz-subhead { font-weight: 700; font-size: 11px; letter-spacing: 0.8px; text-transform: uppercase; color: #7f8fa8; margin: 14px 0 6px; }
.wz-info { font-size: 11px; color: var(--pt-text-muted, #97A0B0); line-height: 1.5; margin: 4px 0 8px; }
/* info icons + pop-out (wz-infoicons-v63b) */
.wz-info-i { display:inline-flex; align-items:center; justify-content:center; width:15px; height:15px; margin-left:5px; border-radius:50%; font:italic 700 10px serif; cursor:pointer; background:rgba(120,150,200,.18); border:1px solid rgba(120,150,200,.4); color:#a8bce0; vertical-align:middle; line-height:1; }
.wz-info-i:hover { background:rgba(54,224,212,.2); border-color:rgba(54,224,212,.55); color:#8ff2e6; }
.wz-info-pop { position:fixed; z-index:100; width:300px; max-width:92vw; background:#141b26; border:1px solid rgba(120,150,200,.35); border-radius:9px; padding:12px 13px 11px; box-shadow:0 10px 30px rgba(0,0,0,.6); }
.wz-info-x { position:absolute; top:5px; right:10px; font-size:16px; line-height:1; color:#7f8fa8; cursor:pointer; }
.wz-info-x:hover { color:#c8d4ea; }
.wz-info-t { font-weight:700; font-size:12px; color:#8ff2e6; margin-bottom:5px; padding-right:14px; }
.wz-info-b { font-size:11px; line-height:1.5; color:#c8d4ea; margin-bottom:8px; }
.wz-info-cmd { display:flex; align-items:center; gap:6px; background:#0b0f16; border:1px solid rgba(120,150,200,.2); border-radius:5px; padding:5px 7px; margin-bottom:5px; }
.wz-info-cmd code { flex:1; font-family:ui-monospace,monospace; font-size:10px; color:#b9e6ff; white-space:pre-wrap; word-break:break-all; }
.wz-info-copy { flex:0 0 auto; font:700 9px ui-monospace,monospace; padding:3px 7px; border-radius:4px; cursor:pointer; background:rgba(54,224,212,.14); border:1px solid rgba(54,224,212,.4); color:#8ff2e6; }
.wz-info-copy:hover { background:rgba(54,224,212,.25); }
.wz-info-f { font-size:10px; line-height:1.45; color:#97a0b0; margin-top:6px; font-style:italic; }
.wz-row { display: flex; gap: 10px; }
.wz-field { margin-bottom: 13px; }
`;

const WZ_INFO = {   /*wz-infoicons-v63b*/
  sshkey: {
    title: 'SSH key access',
    body: "A background connection can't answer a 2FA prompt, so PoolTerminal needs a key-based login to the db-sync machine. Generate a dedicated key, authorise it, and set the permissions - if ~/.ssh is too open, SSH silently ignores the key and falls back to a password prompt.",
    cmds: [
      "ssh-keygen -t ed25519 -f ~/.ssh/pt_dbsync -N ''",
      "cat ~/.ssh/pt_dbsync.pub >> ~/.ssh/authorized_keys",
      "chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys",
    ],
    foot: "Then enter the private key path (e.g. ~/.ssh/pt_dbsync) in the SSH key field. Key auth also bypasses the 2FA that interactive logins use.",
  },
  pglocal: {
    title: 'Postgres on localhost',
    body: "The tunnel connects to Postgres on the db-sync machine's own loopback, so it must be listening on 127.0.0.1:5432. Check with:",
    cmds: ["ss -tlnp | grep 5432"],
    foot: "If nothing shows 127.0.0.1:5432, set  listen_addresses = 'localhost'  in postgresql.conf and reload Postgres. Loopback-only keeps it off the network.",
  },
  pgauth: {
    title: 'Database access',
    body: "Two ways to let the app in: a password for the role, or a loopback-trust line (no password stored) - safe ONLY while Postgres stays localhost-only. For trust, add this ABOVE the scram-sha-256 line in pg_hba.conf (replace <db> and <role>), then reload:",
    cmds: ["host    <db>    <role>    127.0.0.1/32    trust", "sudo systemctl reload postgresql"],
    foot: "Find your pg_hba.conf path with:  sudo -u postgres psql -tA -c \"SHOW hba_file\"",
  },
  dbnames: {
    title: 'Database & role names',
    body: "Not sure of your database and role names? List every database and its owning role:",
    cmds: ["sudo -u postgres psql -l"],
    foot: "The db-sync database is usually \"cexplorer\". Its Owner column is the role to enter above.",
  },
};

function wzFallbackCopy(text, done) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy');
    document.body.removeChild(ta); if (done) done();
  } catch (e) { /* copy unavailable */ }
}
function wzCopyCmd(text, btn) {
  const done = () => { const o = btn.textContent; btn.textContent = 'copied'; setTimeout(() => { btn.textContent = o; }, 1200); };
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => wzFallbackCopy(text, done));
    } else { wzFallbackCopy(text, done); }
  } catch (e) { wzFallbackCopy(text, done); }
}
function closeInfoPop(modal) { const ex = modal.querySelector('.wz-info-pop'); if (ex) ex.remove(); }
function showInfoPop(modal, anchorEl, info) {
  if (!info) return;
  closeInfoPop(modal);
  const pop = document.createElement('div');
  pop.className = 'wz-info-pop';
  const cmdRows = (info.cmds || []).map(() => '<div class="wz-info-cmd"><code></code><button type="button" class="wz-info-copy">copy</button></div>').join('');
  pop.innerHTML = '<div class="wz-info-x" title="Close">\u00d7</div><div class="wz-info-t"></div><div class="wz-info-b"></div>' + cmdRows + (info.foot ? '<div class="wz-info-f"></div>' : '');
  pop.querySelector('.wz-info-t').textContent = info.title || '';
  pop.querySelector('.wz-info-b').textContent = info.body || '';
  if (info.foot) pop.querySelector('.wz-info-f').textContent = info.foot;
  const codeEls = pop.querySelectorAll('.wz-info-cmd code');
  const copyEls = pop.querySelectorAll('.wz-info-copy');
  (info.cmds || []).forEach((c, i) => {
    if (codeEls[i]) codeEls[i].textContent = c;
    if (copyEls[i]) copyEls[i].addEventListener('click', () => wzCopyCmd(c, copyEls[i]));
  });
  pop.querySelector('.wz-info-x').addEventListener('click', () => closeInfoPop(modal));
  modal.appendChild(pop);
  const ar = anchorEl.getBoundingClientRect();
  let left = ar.left - 40;
  if (left < 8) left = 8;
  const maxLeft = window.innerWidth - 308;
  if (left > maxLeft) left = Math.max(8, maxLeft);
  let top = ar.bottom + 6;
  const maxTop = window.innerHeight - pop.offsetHeight - 8;
  if (top > maxTop) top = Math.max(8, ar.top - pop.offsetHeight - 6);
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
}

function wizardGuided() {   /*wz-guided-key-v69*/
  try { return localStorage.getItem('pt.wizard.guided') !== 'off'; } catch (e) { return true; }
}

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

  // Skip-aware navigation: a step whose skip(wiz) returns true is passed over. /*wz-skip-v61*/
  const stepVisible = (i) => { const s = STEPS[i]; return !(s && typeof s.skip === 'function' && s.skip(wiz)); };
  const nextVisibleIdx = (from) => { for (let i = from + 1; i < STEPS.length; i++) if (stepVisible(i)) return i; return -1; };
  const prevVisibleIdx = (from) => { for (let i = from - 1; i >= 0; i--) if (stepVisible(i)) return i; return -1; };

  function paint() {
    const step = STEPS[idx];
    $('#wz-title').textContent = step.title;
    // Wrap content in a fresh node so the entrance animation re-triggers each step.
    $('#wz-body').innerHTML = `<div class="wz-anim">${step.render(wiz)}</div>`;
    $('#wz-err').textContent = '';

    const _vis = STEPS.map((_, i) => i).filter(stepVisible);
    const _cur = _vis.indexOf(idx);
    $('#wz-progress').innerHTML =
      _vis.map((i, p) => `<span class="wz-dot ${p === _cur ? 'wz-dot-on' : p < _cur ? 'wz-dot-done' : ''}"></span>`).join('') +
      `<span class="wz-step-count">Step ${_cur + 1} of ${_vis.length}</span>`;

    const _connectIdx = STEPS.findIndex((s) => s.key === 'connect');
    const _backLocked = prevVisibleIdx(idx) === -1 || (wiz._connected && idx <= _connectIdx + 1);
    $('#wz-back').style.visibility = _backLocked ? 'hidden' : 'visible';
    $('#wz-next').textContent = nextVisibleIdx(idx) === -1 ? 'Finish' : 'Next';
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

    if (step.key === 'dbhave') {   /*wz-dbtree-v62*/
      modal.querySelectorAll('.wz-card[data-yn]').forEach((card) => {
        card.addEventListener('click', () => {
          const yes = card.dataset.yn === 'yes';
          wiz.useDbsync = yes; wiz._dbAnswered = true;
          modal.querySelectorAll('.wz-card[data-yn]').forEach((c) => c.classList.toggle('wz-card-on', c === card));
          $('#wz-err').textContent = '';
          setTimeout(() => { const nb = $('#wz-next'); if (nb) nb.click(); }, 180);   // auto-advance
        });
      });
    }

    if (step.key === 'dbwhere') {
      modal.querySelectorAll('.wz-card[data-dbloc]').forEach((card) => {
        card.addEventListener('click', () => {
          wiz.dbLocation = card.dataset.dbloc;
          modal.querySelectorAll('.wz-card[data-dbloc]').forEach((c) => c.classList.toggle('wz-card-on', c === card));
          $('#wz-err').textContent = '';
          setTimeout(() => { const nb = $('#wz-next'); if (nb) nb.click(); }, 180);   // auto-advance
        });
      });
    }

    if (step.key === 'dbkey') {   /*wz-guided-key-v69*/
      modal.querySelectorAll('.wz-card[data-keymode]').forEach((c) => {
        c.addEventListener('click', () => { wiz._keyMode = c.dataset.keymode; paint(); });
      });
      modal.querySelectorAll('#wz-key-reveal .wz-info-copy[data-copy]').forEach((b) => {
        b.addEventListener('click', () => wzCopyCmd(b.dataset.copy, b));
      });
      const gen = modal.querySelector('#wz-key-gen');
      if (gen) gen.addEventListener('click', async () => {
        const res = modal.querySelector('#wz-key-gen-result');
        const pathEl = modal.querySelector('#wz-key-path');
        const pubEl = modal.querySelector('#wz-key-pub');
        const authRev = modal.querySelector('#wz-key-authorise');
        if (res) { res.textContent = 'Generating…'; res.className = 'wz-test-result wz-test-pending'; }
        gen.disabled = true;
        try {
          const { invoke } = await import('../data/tauri.js');
          const cmd = 'KP="$HOME/.ssh/pt_dbsync"; if [ -f "$KP" ]; then ST=exists; else ssh-keygen -t ed25519 -f "$KP" -N "" >/dev/null 2>&1 && ST=created || ST=failed; fi; echo "PATH=$KP"; echo "STATUS=$ST"; echo "PUB=$(cat "$KP.pub" 2>/dev/null)"';
          const r = await invoke('local_run', { command: cmd });
          const out = (r && r.stdout) || '';
          const path = ((out.match(/PATH=(.*)/) || [])[1] || '').trim();
          const status = ((out.match(/STATUS=(.*)/) || [])[1] || '').trim();
          const pub = ((out.match(/PUB=(.*)/) || [])[1] || '').trim();
          if (status === 'failed' || !pub) {
            if (res) { res.textContent = 'Could not generate the key — is ssh-keygen installed?'; res.className = 'wz-test-result wz-test-bad'; }
          } else {
            if (pathEl && path) pathEl.value = path;
            if (pubEl) pubEl.textContent = pub;
            if (authRev) authRev.classList.add('wz-reveal-open');
            const pubCopy = modal.querySelector('#wz-key-pub-copy');
            if (pubCopy) pubCopy.onclick = () => wzCopyCmd(pub, pubCopy);
            if (res) { res.textContent = status === 'exists' ? 'Key already existed — reusing it ✓' : 'Key created ✓'; res.className = 'wz-test-result wz-test-good'; }
            refreshNext();
          }
        } catch (e) {
          if (res) { res.textContent = 'Could not generate the key: ' + (e.message || e); res.className = 'wz-test-result wz-test-bad'; }
        } finally { gen.disabled = false; }
      });
    }

    if (step.key === 'dbconn') {
      modal.querySelectorAll('.wz-info-i').forEach((ic) => {   /*wz-infoicons-v63b*/
        ic.addEventListener('click', (e) => { e.stopPropagation(); showInfoPop(modal, ic, WZ_INFO[ic.dataset.info]); });
      });
      modal.addEventListener('click', (e) => {
        const pop = modal.querySelector('.wz-info-pop');
        if (pop && !pop.contains(e.target) && !(e.target.classList && e.target.classList.contains('wz-info-i'))) closeInfoPop(modal);
      });
      // Auth-method toggle: show/hide the password row and the trust note.
      const authEl = modal.querySelector('#wz-db-auth');   /*wz-authseg-v63a4*/
      const applyAuthReveal = () => {
        const pw = modal.querySelector('#wz-db-passrow');
        const tn = modal.querySelector('#wz-db-trustnote');
        const isPw = !authEl || authEl.value === 'password';
        if (pw) pw.classList.toggle('wz-creds-hidden', !isPw);
        if (tn) tn.classList.toggle('wz-creds-hidden', isPw);
      };
      modal.querySelectorAll('#wz-db-auth-seg .wz-seg-btn').forEach((b) => {
        b.addEventListener('click', () => {
          if (authEl) authEl.value = b.dataset.auth;
          modal.querySelectorAll('#wz-db-auth-seg .wz-seg-btn').forEach((x) => x.classList.toggle('wz-seg-on', x === b));
          applyAuthReveal();
        });
      });
      const dbTest = modal.querySelector('#wz-db-test');
      if (dbTest) dbTest.addEventListener('click', async () => {   /*wz-wire-v63*/
        const res = modal.querySelector('#wz-db-test-result');
        if (!res) return;
        if (!wiz.poolHex) {
          res.textContent = 'Connect to your node first (needed to find your pool).';
          res.className = 'wz-test-result wz-test-bad'; return;
        }
        const loc = wiz.dbLocation || 'local';
        const v = (id) => { const el = modal.querySelector(id); return el ? el.value.trim() : ''; };
        const authEl = modal.querySelector('#wz-db-auth');
        const authMode = authEl ? authEl.value : 'password';
        const mode = loc === 'local' ? 'local' : loc === 'bp' ? 'tunnel' : 'ssh';
        const dbsync = {
          database: v('#wz-db-name') || 'cexplorer',
          user: v('#wz-db-user'),
          host: v('#wz-db-host') || (loc === 'local' ? '' : '127.0.0.1'),
          port: Number(v('#wz-db-port')) || 5432,
          password: authMode === 'password' ? v('#wz-db-pass') : '',
        };
        res.textContent = 'Testing...'; res.className = 'wz-test-result wz-test-pending';
        dbTest.disabled = true;
        try {
          if (loc === 'remote') {
            const sshParams = {
              host: v('#wz-ssh-host'), port: Number(v('#wz-ssh-port')) || 22,
              username: v('#wz-ssh-user'),
              auth: { type: 'key', path: v('#wz-ssh-key'), passphrase: v('#wz-ssh-pass') || null },
            };
            res.textContent = 'Opening SSH connection to the db-sync machine...';
            try {
              const { connectDbsyncSsh } = await import('../data/pg-transport.js');
              await connectDbsyncSsh(sshParams);
            } catch (e) {
              res.textContent = 'Could not open the SSH connection - check the SSH host, port, username and key path. (' + (e.message ?? e) + ')';
              res.className = 'wz-test-result wz-test-bad'; dbTest.disabled = false; return;
            }
            dbsync.ssh = sshParams;
            res.textContent = 'SSH connected - querying db-sync...';
          }
          const ok = await initDbsync(buildDbsyncConfig({ dbsyncMode: mode, dbsync }), wiz.poolHex);
          if (ok) {
            res.textContent = 'Connected to db-sync \u2713';
            res.className = 'wz-test-result wz-test-good';
          } else {
            res.textContent = loc === 'local'
              ? 'Could not reach db-sync on the local socket - check the database name and role.'
              : 'Reached the machine, but the database query did not succeed - check the database name, role, and your password / loopback-trust setup.';
            res.className = 'wz-test-result wz-test-bad';
          }
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
    const pi = prevVisibleIdx(idx);
    if (pi !== -1) { idx = pi; paint(); }
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
    const ni = nextVisibleIdx(idx);
    if (ni !== -1) { idx = ni; paint(); }
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
      authMode: d.authMode || 'password',
      savePassword: !!d.savePassword,
      password: d.savePassword ? (d.password || '') : '',
    };
    if (wiz.dbsyncMode === 'ssh' && d.ssh) {   /*wz-wire-v63*/
      out.dbsync.ssh = {
        host: d.ssh.host || '',
        port: d.ssh.port || 22,
        username: d.ssh.username || '',
        auth: {
          type: 'key',
          path: (d.ssh.auth && d.ssh.auth.path) || '',
          passphrase: null,   /*no-passphrase-at-rest-v73*/ // never persisted; use ssh-agent or re-enter per session
        },
      };
    }
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
  cfg.host = d.host || (mode === 'tunnel' || mode === 'ssh' ? '127.0.0.1' : '');
  cfg.port = d.port || 5432;
  if (d.user) cfg.user = d.user;
  if (d.password) cfg.password = d.password;
  if (mode === 'tunnel') cfg.viaSsh = true;   // honoured only when SSH_TUNNEL_ENABLED
  if (mode === 'ssh') cfg.sshVia = 'dbsync';   // independent SSH session /*wz-wire-v63*/
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
