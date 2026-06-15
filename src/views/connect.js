/**
 * PoolTerminal — Connection modal.
 *
 * Probes the env file once on connect:
 *  - cd into env's directory first (so $CNODE_HOME resolves correctly)
 *  - source ./env offline (skips slow Koios protocol-params call)
 *  - extract every path / anchor live.js needs:
 *      paths    : CCLI, CARDANO_NODE_SOCKET_PATH, CNODE_HOME, CNCLI, CNCLI_DB
 *      identity : POOL_TICKER, POOL_NAME, POOL_ID
 *      network  : NETWORK_NAME, NETWORK_IDENTIFIER
 *      genesis  : SHELLEY_GENESIS_START_SEC, SHELLEY_TRANS_EPOCH,
 *                 BYRON_EPOCH_LENGTH, EPOCH_LENGTH
 *  - derive CNCLI_DB from CNODE_HOME if env didn't set it (Guild stock doesn't)
 *
 * Subsequent per-poll queries use these cached values via absolute paths — no
 * re-sourcing of the env file per call.
 */

import { invoke } from '../data/tauri.js';
import { loadConfig, saveConfig, markConnected, setTransport } from '../data/session.js';
import { setMode } from '../data/index.js';
import { resetNowLoading } from './now.js';

const MODAL_HTML = `
<div class="pt-modal-backdrop" id="cn-modal">
  <div class="pt-modal">
    <div class="pt-modal-header">
      <div class="pt-modal-title">Connect to your node</div>
      <div class="pt-modal-sub">SSH password and OTP are never stored. Host and paths are remembered for next launch.</div>
    </div>
    <style>
.pt-modal input,
.pt-modal select {
  background-color: #0e1620 !important;
  color: #ffffff !important;
  -webkit-text-fill-color: #ffffff !important;
  border: 1px solid rgba(120,150,190,0.5) !important;
  border-radius: 4px !important;
  padding: 7px 9px !important;
  font: 600 13px ui-monospace, monospace !important;
}
.pt-modal select {
  -webkit-appearance: none !important;
  -moz-appearance: none !important;
  appearance: none !important;
  background-color: #16202e !important;
  background-image: linear-gradient(45deg, transparent 50%, #9fb4cc 50%), linear-gradient(135deg, #9fb4cc 50%, transparent 50%) !important;
  background-position: right 14px center, right 9px center !important;
  background-size: 5px 5px, 5px 5px !important;
  background-repeat: no-repeat, no-repeat !important;
  padding-right: 28px !important;
  cursor: pointer !important;
}
.pt-modal select option {
  background-color: #0e1620 !important;
  color: #ffffff !important;
  -webkit-text-fill-color: #ffffff !important;
}
</style>
    <div class="pt-modal-body">

      <div class="pt-field">
        <label>Connection type</label>
        <select id="cn-conn-type">
          <option value="ssh">Remote node (connect over SSH)</option>
          <option value="local">This machine (PoolTerminal runs on the node)</option>
        </select>
        <div class="pt-field-hint">Choose "This machine" if PoolTerminal is installed on the same box as your node — no SSH or password needed.</div>
      </div>

      <div id="cn-remote-group">
      <div class="pt-field-row">
        <div class="pt-field" style="flex: 2">
          <label>Host</label>
          <input id="cn-host" type="text" placeholder="192.168.0.62" autocomplete="off">
        </div>
        <div class="pt-field" style="flex: 0.6">
          <label>Port</label>
          <input id="cn-port" type="number" value="22" autocomplete="off">
        </div>
        <div class="pt-field" style="flex: 1.5">
          <label>Username</label>
          <input id="cn-user" type="text" placeholder="russell" autocomplete="off">
        </div>
      </div>
      </div>

      <div class="pt-field">
        <label>Env file path (on the node)</label>
        <input id="cn-env" type="text" placeholder="/opt/cardano/cnode_bp/scripts/env" autocomplete="off">
        <div class="pt-field-hint">Your Guild Operators env file. Sourced once with "offline" flag so all paths come from one canonical source.</div>
      </div>

      <div id="cn-auth-section">
      <div class="pt-field">
        <label>Authentication method</label>
        <select id="cn-auth-method">
          <option value="password">Password / 2FA</option>
          <option value="key">SSH key file</option>
          <option value="agent">SSH agent (recommended for cloud)</option>
        </select>
      </div>

      <div id="cn-pw-group">
        <div class="pt-field">
          <label>Authentication order</label>
          <select id="cn-auth-order">
            <option value="code_then_password">OTP code → Password</option>
            <option value="password_then_code">Password → OTP code</option>
            <option value="password_only">Password only (no 2FA)</option>
          </select>
        </div>

        <div class="pt-field-row">
          <div class="pt-field" id="cn-code-field" style="flex: 1">
            <label>OTP code</label>
            <input id="cn-code" type="text" placeholder="000000" maxlength="8" autocomplete="off">
          </div>
          <div class="pt-field" style="flex: 2">
            <label>Password</label>
            <input id="cn-password" type="password" autocomplete="off">
          </div>
        </div>
      </div>

      <div id="cn-key-group" style="display:none">
        <div class="pt-field">
          <label>SSH key</label>
          <select id="cn-key"><option value="">— no keys found in ~/.ssh —</option></select>
          <div class="pt-field-hint">Keys found on this computer (where PoolTerminal runs). Pick the one you use for this server, or choose "Custom path…" for a cloud .pem.</div>
        </div>
        <div class="pt-field" id="cn-key-custom-field" style="display:none">
          <label>Key file path</label>
          <input id="cn-key-custom" type="text" placeholder="/home/you/Downloads/aws-relay.pem" autocomplete="off">
        </div>
        <div class="pt-field">
          <label>Key passphrase <span style="opacity:.6">(only if your key has one)</span></label>
          <input id="cn-key-pass" type="password" autocomplete="off">
        </div>
      </div>

      <div id="cn-agent-group" style="display:none">
        <div class="pt-field-hint" style="padding:8px 0">
          Uses your running SSH agent — the same keys <code>ssh</code> uses in a terminal. Make sure your key is loaded (<code>ssh-add</code>). No path or passphrase needed here.
        </div>
      </div>
      </div>

      <div class="pt-modal-error" id="cn-error" style="display:none"></div>
      <div class="pt-modal-status" id="cn-status" style="display:none"></div>
    </div>
    <div class="pt-modal-actions">
      <button id="cn-skip" class="pt-btn pt-btn-secondary">Use Demo Mode</button>
      <button id="cn-connect" class="pt-btn pt-btn-primary">Connect</button>
    </div>
  </div>
</div>`;

function byId(id) { return document.getElementById(id); }

function setErr(msg) {
  const el = byId('cn-error');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
  byId('cn-status').style.display = 'none';
}

function setStatus(msg) {
  const el = byId('cn-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
  byId('cn-error').style.display = 'none';
}

function parseEnvProbe(out) {
  const vars = {};
  const idx = out.indexOf('__PROBE_OK__');
  const slice = idx >= 0 ? out.slice(idx) : out;
  slice.split('\n').forEach((line) => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) vars[m[1]] = m[2];
  });
  return vars;
}

function unwrapSsh(r) {
  if (typeof r === 'string') return r;
  return r?.stdout ?? '';
}

function gatherFormValues() {
  const keySel = byId('cn-key');
  const keyDropdownVal = keySel ? keySel.value : '';
  const isCustom = keyDropdownVal === '__custom__';
  const connType = byId('cn-conn-type').value;   // 'ssh' | 'local'
  return {
    transport: connType,
    host: connType === 'local' ? 'localhost' : byId('cn-host').value.trim(),
    port: parseInt(byId('cn-port').value, 10) || 22,
    user: byId('cn-user').value.trim(),
    envFile: byId('cn-env').value.trim(),
    authMethod: byId('cn-auth-method').value,
    authOrder: byId('cn-auth-order').value,
    password: byId('cn-password').value,
    code: byId('cn-code').value.trim(),
    keyPath: isCustom ? byId('cn-key-custom').value.trim() : keyDropdownVal,
    keyPass: byId('cn-key-pass').value,
  };
}

function validate(conn) {
  if (conn.transport === 'local') {
    if (!conn.envFile) return 'Env file path is required';
    return null;   // local mode needs nothing else
  }
  if (!conn.host) return 'Host is required';
  if (/^(localhost|127\.0\.0\.1|::1)$/i.test(conn.host))
    return 'For SSH, enter the node\u2019s real address (e.g. 192.168.0.62), not localhost. Use "This machine" if PoolTerminal runs on the node itself.';
  if (!conn.user) return 'Username is required';
  if (!conn.envFile) return 'Env file path is required';
  if (conn.authMethod === 'agent') return null;
  if (conn.authMethod === 'key') {
    if (!conn.keyPath) return 'Select an SSH key, or enter a key file path';
    return null;
  }
  if (!conn.password) return 'Password is required';
  if (conn.authOrder !== 'password_only' && !conn.code) return 'OTP code is required for this auth order';
  return null;
}

function updateAuthUI() {
  const connType = byId('cn-conn-type').value;
  const isLocal = connType === 'local';
  // Local mode needs no host/port/user or auth at all — just the env path.
  const remote = byId('cn-remote-group');
  const authSec = byId('cn-auth-section');
  if (remote) remote.style.display = isLocal ? 'none' : '';
  if (authSec) authSec.style.display = isLocal ? 'none' : '';
  if (isLocal) return;

  const method = byId('cn-auth-method').value;
  byId('cn-pw-group').style.display = method === 'password' ? '' : 'none';
  byId('cn-key-group').style.display = method === 'key' ? '' : 'none';
  byId('cn-agent-group').style.display = method === 'agent' ? '' : 'none';
  if (method === 'password') {
    const order = byId('cn-auth-order').value;
    byId('cn-code-field').style.display = order === 'password_only' ? 'none' : '';
  }
  if (method === 'key') {
    const sel = byId('cn-key');
    byId('cn-key-custom-field').style.display = (sel && sel.value === '__custom__') ? '' : 'none';
  }
}

// Populate the SSH-key dropdown from the local ~/.ssh (where PT runs), plus a
// "Custom path…" entry for cloud .pem files kept elsewhere.
async function populateKeys(preferredPath) {
  const sel = byId('cn-key');
  if (!sel) return;
  let keys = [];
  try { keys = (await invoke('list_ssh_keys')) || []; }
  catch (e) { console.warn('[connect] list_ssh_keys:', e?.message ?? e); }
  const opts = keys.map((k) => `<option value="${k.path}">${k.name} (${k.kind})</option>`);
  opts.push('<option value="__custom__">Custom path… (e.g. cloud .pem)</option>');
  sel.innerHTML = opts.join('');
  if (preferredPath && keys.some((k) => k.path === preferredPath)) sel.value = preferredPath;
  sel.addEventListener('change', updateAuthUI);
}

function splitEnvPath(envFile) {
  const idx = envFile.lastIndexOf('/');
  return idx === -1
    ? { dir: '.', name: envFile }
    : { dir: envFile.slice(0, idx), name: envFile.slice(idx + 1) };
}

export function showConnectModal(onDone) {
  const wrap = document.createElement('div');
  wrap.innerHTML = MODAL_HTML;
  const modal = wrap.firstElementChild;
  document.body.appendChild(modal);

  const cfg = loadConfig();
  // Self-heal: the host field is the REMOTE host. If a prior local-mode run
  // left "localhost" (or it's blank) in the saved config, don't load that into
  // the SSH host field — fall back to the default so an SSH connect can't be
  // mis-aimed at localhost and refused.
  const isLocalHostVal = (h) => !h || /^(localhost|127\.0\.0\.1|::1)$/i.test(String(h).trim());
  byId('cn-host').value = (cfg.transport !== 'local' && !isLocalHostVal(cfg.host))
    ? cfg.host
    : '192.168.0.62';
  byId('cn-port').value = cfg.port || 22;
  byId('cn-user').value = cfg.user || 'russell';
  byId('cn-env').value = cfg.envFile || '/opt/cardano/cnode_bp/scripts/env';
  byId('cn-auth-order').value = cfg.authOrder || 'code_then_password';
  byId('cn-auth-method').value = cfg.authMethod || 'password';
  byId('cn-conn-type').value = cfg.transport || 'ssh';
  populateKeys(cfg.keyPath);
  updateAuthUI();
  byId('cn-auth-order').addEventListener('change', updateAuthUI);
  byId('cn-auth-method').addEventListener('change', updateAuthUI);
  byId('cn-conn-type').addEventListener('change', updateAuthUI);
  // When switching to SSH, never leave a leftover "localhost" in the host box.
  byId('cn-conn-type').addEventListener('change', () => {
    if (byId('cn-conn-type').value !== 'local' && isLocalHostVal(byId('cn-host').value)) {
      byId('cn-host').value = '192.168.0.62';
    }
  });

  byId('cn-skip').addEventListener('click', () => {
    setMode('demo');
    modal.remove();
    if (onDone) onDone({ mode: 'demo' });
  });

  byId('cn-connect').addEventListener('click', async () => {
    const conn = gatherFormValues();
    const err = validate(conn);
    if (err) { setErr(err); return; }

    const connectBtn = byId('cn-connect');
    const skipBtn = byId('cn-skip');
    connectBtn.disabled = true;
    skipBtn.disabled = true;

    try {
      // Set the transport up front so the env probe below (which calls
      // invoke('ssh_run')) routes to local_run automatically in local mode.
      setTransport(conn.transport);

      if (conn.transport === 'local') {
        // PoolTerminal runs ON the node — no SSH, no credentials. Just verify we
        // can run commands locally, then go straight to the env probe.
        setStatus('Checking local node access…');
        const ok = await invoke('local_probe');
        if (!ok) throw new Error('Could not run commands locally on this machine.');
      } else {
        setStatus('Opening SSH connection…');
        // Pick the SSH auth method. Agent uses the running ssh-agent (cloud
        // default); key uses a chosen/typed key file (encrypted keys decrypt
        // with the passphrase); password-only uses the plain SSH password
        // method; the 2FA orders use keyboard-interactive.
        let auth;
        if (conn.authMethod === 'agent') {
          auth = { type: 'agent' };
        } else if (conn.authMethod === 'key') {
          auth = { type: 'key', path: conn.keyPath, passphrase: conn.keyPass || null };
        } else if (conn.authOrder === 'password_only') {
          auth = { type: 'password', password: conn.password };
        } else {
          auth = { type: 'keyboard_interactive', password: conn.password, code: conn.code || '', order: conn.authOrder };
        }

        await invoke('ssh_connect', {
          params: {
            host: conn.host,
            port: conn.port,
            username: conn.user,
            auth,
          },
        });
      }

      setStatus('Sourcing env file and probing paths…');

      const { dir: envDir, name: envName } = splitEnvPath(conn.envFile);
      // Source the env, then print markers + variables UNCONDITIONALLY (`;` not
      // `&&`). Guild env files can return a non-zero exit on a harmless warning
      // (e.g. a node-version mismatch on a relay) even though they sourced fine
      // and all variables are set — so we must NOT gate on the source exit code.
      // Success is judged by whether the variables actually came back (CCLI),
      // not by `$?`. `cd` failing is the only real blocker, so keep that as `&&`.
      const probeCmd =
        `cd ${envDir} && { source ./${envName} offline >/dev/null 2>&1; ` +
        `echo "__PROBE_OK__"; ` +
        `echo "CCLI=$CCLI"; ` +
        `echo "CARDANO_NODE_SOCKET_PATH=$CARDANO_NODE_SOCKET_PATH"; ` +
        `echo "CNODE_HOME=$CNODE_HOME"; ` +
        `echo "CNCLI=$CNCLI"; ` +
        `echo "CNCLI_DB=$CNCLI_DB"; ` +
        `echo "NETWORK_NAME=$NETWORK_NAME"; ` +
        `echo "NETWORK_IDENTIFIER=$NETWORK_IDENTIFIER"; ` +
        `echo "POOL_TICKER=$POOL_TICKER"; ` +
        `echo "POOL_ID=$POOL_ID"; ` +
        `echo "POOL_NAME=$POOL_NAME"; ` +
        `echo "SHELLEY_GENESIS_START_SEC=$SHELLEY_GENESIS_START_SEC"; ` +
        `echo "SHELLEY_TRANS_EPOCH=$SHELLEY_TRANS_EPOCH"; ` +
        `echo "BYRON_EPOCH_LENGTH=$BYRON_EPOCH_LENGTH"; ` +
        `echo "EPOCH_LENGTH=$EPOCH_LENGTH"; }`;
      const probeOut = unwrapSsh(await invoke('ssh_run', { command: probeCmd }));

      const envVars = parseEnvProbe(probeOut);

      // Judge success by whether the env actually yielded the essentials, not by
      // the marker alone — a warning-printing env still gives us real values.
      if (!probeOut.includes('__PROBE_OK__') || !envVars.CCLI) {
        throw new Error(
          `Env file sourced but didn't yield the expected variables ` +
          `(got CCLI="${envVars.CCLI || ''}", CNODE_HOME="${envVars.CNODE_HOME || ''}").\n` +
          `Check the env path is correct for this node. Raw output:\n${probeOut}`
        );
      }

      if (!envVars.CNCLI_DB && envVars.CNODE_HOME) {
        envVars.CNCLI_DB = `${envVars.CNODE_HOME}/guild-db/cncli/cncli.db`;
      }

      // Derive the socket path if the env didn't surface it. The Guild env sets
      // CARDANO_NODE_SOCKET_PATH by grepping the running node's --socket-path
      // arg; in a non-interactive `offline` SSH probe that grep can come up
      // empty, so the env's own documented fallback ($CNODE_HOME/sockets/
      // node.socket) doesn't get exported. We apply the same fallback here, so a
      // node whose env doesn't yield the socket (common on relays) still works.
      if (!envVars.CARDANO_NODE_SOCKET_PATH && envVars.CNODE_HOME) {
        envVars.CARDANO_NODE_SOCKET_PATH = `${envVars.CNODE_HOME}/sockets/node.socket`;
        console.log('[connect] derived socket path from CNODE_HOME:', envVars.CARDANO_NODE_SOCKET_PATH);
      }

      if (!envVars.CCLI) {
        throw new Error(`Env probe didn't yield $CCLI. Got:\n${probeOut}`);
      }
      if (!envVars.CARDANO_NODE_SOCKET_PATH) {
        throw new Error(
          `Could not determine the node socket path. The env didn't set ` +
          `CARDANO_NODE_SOCKET_PATH and no CNODE_HOME was available to derive it.\n` +
          `Raw output:\n${probeOut}`
        );
      }
      if (!envVars.NETWORK_IDENTIFIER) {
        envVars.NETWORK_IDENTIFIER = '--mainnet';
      }

      console.log('[connect] env probe OK', envVars);

      // Persist connection prefs WITHOUT secrets (password, OTP, key passphrase
      // are never written to disk — only remembered for this session in memory).
      saveConfig({ ...conn, password: '', code: '', keyPass: '' });
      markConnected(conn, envVars);
      resetNowLoading();   // fresh connection — show the loading sequence again
      setMode('live');

      modal.remove();
      if (onDone) onDone({ mode: 'live', envVars });
    } catch (e) {
      setErr(typeof e === 'string' ? e : (e?.message || String(e)));
      connectBtn.disabled = false;
      skipBtn.disabled = false;
    }
  });
}
