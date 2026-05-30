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
import { loadConfig, saveConfig, markConnected } from '../data/session.js';
import { setMode } from '../data/index.js';

const MODAL_HTML = `
<div class="pt-modal-backdrop" id="cn-modal">
  <div class="pt-modal">
    <div class="pt-modal-header">
      <div class="pt-modal-title">Connect to your node</div>
      <div class="pt-modal-sub">SSH password and OTP are never stored. Host and paths are remembered for next launch.</div>
    </div>
    <div class="pt-modal-body">

      <div class="pt-field-row">
        <div class="pt-field" style="flex: 2">
          <label>Host</label>
          <input id="cn-host" type="text" placeholder="192.168.0.62" autocomplete="off">
        </div>
        <div class="pt-field" style="flex: 1">
          <label>Port</label>
          <input id="cn-port" type="number" value="22" autocomplete="off">
        </div>
        <div class="pt-field" style="flex: 1.5">
          <label>Username</label>
          <input id="cn-user" type="text" placeholder="russell" autocomplete="off">
        </div>
      </div>

      <div class="pt-field">
        <label>Env file path (on the node)</label>
        <input id="cn-env" type="text" placeholder="/opt/cardano/cnode_bp/scripts/env" autocomplete="off">
        <div class="pt-field-hint">Your Guild Operators env file. Sourced once with "offline" flag so all paths come from one canonical source.</div>
      </div>

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
  return {
    host: byId('cn-host').value.trim(),
    port: parseInt(byId('cn-port').value, 10) || 22,
    user: byId('cn-user').value.trim(),
    envFile: byId('cn-env').value.trim(),
    authOrder: byId('cn-auth-order').value,
    password: byId('cn-password').value,
    code: byId('cn-code').value.trim(),
  };
}

function validate(conn) {
  if (!conn.host) return 'Host is required';
  if (!conn.user) return 'Username is required';
  if (!conn.envFile) return 'Env file path is required';
  if (!conn.password) return 'Password is required';
  if (conn.authOrder !== 'password_only' && !conn.code) return 'OTP code is required for this auth order';
  return null;
}

function updateAuthOrderUI() {
  const order = byId('cn-auth-order').value;
  byId('cn-code-field').style.display = order === 'password_only' ? 'none' : '';
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
  byId('cn-host').value = cfg.host || '192.168.0.62';
  byId('cn-port').value = cfg.port || 22;
  byId('cn-user').value = cfg.user || 'russell';
  byId('cn-env').value = cfg.envFile || '/opt/cardano/cnode_bp/scripts/env';
  byId('cn-auth-order').value = cfg.authOrder || 'code_then_password';
  updateAuthOrderUI();
  byId('cn-auth-order').addEventListener('change', updateAuthOrderUI);

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
    setStatus('Opening SSH connection…');

    try {
      await invoke('ssh_connect', {
        params: {
          host: conn.host,
          port: conn.port,
          username: conn.user,
          auth: {
            type: 'keyboard_interactive',
            password: conn.password,
            code: conn.code || '',
            order: conn.authOrder,
          },
        },
      });

      setStatus('Sourcing env file and probing paths…');

      const { dir: envDir, name: envName } = splitEnvPath(conn.envFile);
      const probeCmd =
        `cd ${envDir} && source ./${envName} offline >/dev/null 2>&1 && ` +
        `echo "__PROBE_OK__" && ` +
        `echo "CCLI=$CCLI" && ` +
        `echo "CARDANO_NODE_SOCKET_PATH=$CARDANO_NODE_SOCKET_PATH" && ` +
        `echo "CNODE_HOME=$CNODE_HOME" && ` +
        `echo "CNCLI=$CNCLI" && ` +
        `echo "CNCLI_DB=$CNCLI_DB" && ` +
        `echo "NETWORK_NAME=$NETWORK_NAME" && ` +
        `echo "NETWORK_IDENTIFIER=$NETWORK_IDENTIFIER" && ` +
        `echo "POOL_TICKER=$POOL_TICKER" && ` +
        `echo "POOL_ID=$POOL_ID" && ` +
        `echo "POOL_NAME=$POOL_NAME" && ` +
        `echo "SHELLEY_GENESIS_START_SEC=$SHELLEY_GENESIS_START_SEC" && ` +
        `echo "SHELLEY_TRANS_EPOCH=$SHELLEY_TRANS_EPOCH" && ` +
        `echo "BYRON_EPOCH_LENGTH=$BYRON_EPOCH_LENGTH" && ` +
        `echo "EPOCH_LENGTH=$EPOCH_LENGTH"`;
      const probeOut = unwrapSsh(await invoke('ssh_run', { command: probeCmd }));

      if (!probeOut.includes('__PROBE_OK__')) {
        throw new Error(`Env file failed to source. Output was:\n${probeOut}`);
      }

      const envVars = parseEnvProbe(probeOut);

      if (!envVars.CNCLI_DB && envVars.CNODE_HOME) {
        envVars.CNCLI_DB = `${envVars.CNODE_HOME}/guild-db/cncli/cncli.db`;
      }

      if (!envVars.CCLI) {
        throw new Error(`Env probe didn't yield $CCLI. Got:\n${probeOut}`);
      }
      if (!envVars.CARDANO_NODE_SOCKET_PATH) {
        throw new Error(`Env probe didn't yield $CARDANO_NODE_SOCKET_PATH. Got:\n${probeOut}`);
      }
      if (!envVars.NETWORK_IDENTIFIER) {
        envVars.NETWORK_IDENTIFIER = '--mainnet';
      }

      console.log('[connect] env probe OK', envVars);

      saveConfig(conn);
      markConnected(conn, envVars);
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
