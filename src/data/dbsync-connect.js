/**
 * PoolTerminal — the one db-sync connect path (0.4.1).
 *
 * Before 0.4.1 the wizard's Test button, Finish and app startup each built and
 * opened db-sync their own way. Test used the password and key passphrase typed
 * into the form; startup used only what had been saved (no password unless
 * "Remember" was ticked, never the passphrase). So Test could pass and the
 * same setup fail after a restart, silently falling back to Koios.
 *
 * Now all three call connectDbsync(choice, secrets, poolHex) with the same
 * inputs, and it returns a status the UI can show:
 *
 *   { state: 'ok' }
 *   { state: 'not-configured' }
 *   { state: 'needs-password', need: ['password'|'passphrase', ...], keyPath }
 *   { state: 'failed', stage, error }
 *
 * Stages: key (SSH key file), ssh (SSH login / host key), tunnel (port
 * forward), connect / auth / query (Postgres), pool (pool not in this db-sync).
 *
 * `choice` has the shape saved in localStorage 'poolterminal.source.v1'.
 * Secrets typed in this session (password, key passphrase) are held in memory
 * only, never persisted here; a remembered password comes from the choice.
 * (dbsync-status-v1)
 */

import { invoke } from './tauri.js';
import { initDbsyncDetailed } from './dbsync-query.js';
import { connectDbsyncSsh, setDbsyncReconnect } from './pg-transport.js';
import { markDbsyncDown } from './dbsync-query.js';

export const SOURCE_CHOICE_KEY = 'poolterminal.source.v1';

/** Plain-language names for the failure stages. */
export const STAGE_LABEL = {
  key: 'SSH key',
  ssh: 'SSH login',
  tunnel: 'SSH tunnel',
  connect: 'database connection',
  auth: 'database login',
  query: 'database query',
  pool: 'pool lookup',
};

let _status = { state: 'not-configured' };
let _lastSshParams = null;   // for one reconnect when the session drops (ssh-keepalive-v1)
let _reconnecting = null;

// Called by pg-transport when a query finds the db-sync SSH session gone.
// One reconnect attempt; on failure db-sync is marked down, the status says
// why, and the normal retry-with-backoff in read-model takes over.
setDbsyncReconnect(async (why) => {
  if (!_lastSshParams) throw new Error(why);
  if (!_reconnecting) {
    _reconnecting = connectDbsyncSsh(_lastSshParams)
      .then(() => { console.log('[dbsync] SSH session reconnected'); })
      .catch((e) => {
        markDbsyncDown();
        setStatus({ state: 'failed', stage: 'ssh', error: `SSH session dropped and could not be reopened: ${e.message ?? e}` });
        throw e;
      })
      .finally(() => { _reconnecting = null; });
  }
  return _reconnecting;
});
const _secrets = { password: null, passphrase: null };

/** The saved data-source choice ({} if none or unreadable). */
export function savedSourceChoice() {
  try { return JSON.parse(localStorage.getItem(SOURCE_CHOICE_KEY) || '{}') || {}; } catch { return {}; }
}

/** Secrets entered this session (wizard Finish or the startup prompt). */
export function setSessionSecrets({ password, passphrase } = {}) {
  if (password !== undefined) _secrets.password = password || null;
  if (passphrase !== undefined) _secrets.passphrase = passphrase || null;
}
export function sessionSecrets() { return { ..._secrets }; }

export function getDbsyncStatus() { return _status; }

function setStatus(st) {
  _status = { ...st, at: Date.now() };
  try { window.dispatchEvent(new CustomEvent('pt:dbsync-status', { detail: _status })); } catch { /* no window (tests) */ }
  return _status;
}

/** Postgres config for initDbsync from a saved-choice-shaped object. */
export function dbsyncConfig(choice, password) {
  const mode = choice.dbsyncMode || 'local';
  const d = choice.dbsync || {};
  const cfg = { database: d.database || 'cexplorer' };
  if (mode === 'local') return cfg;
  cfg.host = d.host || '127.0.0.1';
  cfg.port = d.port || 5432;
  if (d.user) cfg.user = d.user;
  if (password) cfg.password = password;
  if (mode === 'tunnel') cfg.viaSsh = true;    // rides the node's SSH session
  if (mode === 'ssh') cfg.sshVia = 'dbsync';   // its own SSH session
  return cfg;
}

/**
 * Open db-sync from `choice` + `secrets`. Always resolves to a status (never
 * throws) and publishes it as the current status.
 */
export async function connectDbsync(choice, secrets = {}, poolHex = null) {
  if (!choice || choice.useDbsync !== true) return setStatus({ state: 'not-configured' });
  const mode = choice.dbsyncMode || 'local';
  const d = choice.dbsync || {};
  const password = secrets.password || (d.savePassword ? d.password : '') || '';
  const passphrase = secrets.passphrase || '';
  const need = [];

  let sshParams = null;
  if (mode === 'ssh') {
    const s = d.ssh || {};
    const keyPath = (s.auth && s.auth.path) || '';
    if (!s.host || !s.username || !s.port) {
      return setStatus({ state: 'failed', stage: 'ssh', error: 'The SSH host, port or username for the db-sync machine is missing - re-run the setup wizard.' });
    }
    let ks;
    try { ks = await invoke('ssh_key_status', { path: keyPath }); }
    catch (e) { return setStatus({ state: 'failed', stage: 'key', error: `Could not check the SSH key: ${e.message ?? e}` }); }
    if (!ks.exists || !ks.readable || ks.error) {
      return setStatus({ state: 'failed', stage: 'key', error: ks.error || `SSH key ${keyPath} cannot be used.` });
    }
    if (ks.encrypted && !passphrase) need.push('passphrase');
    sshParams = { host: s.host, port: Number(s.port), username: s.username, auth: { type: 'key', path: keyPath, passphrase: passphrase || null } };
  }
  if (mode !== 'local' && (d.authMode || 'password') === 'password' && !password) need.push('password');
  if (need.length) {
    return setStatus({ state: 'needs-password', need, keyPath: sshParams ? sshParams.auth.path : null, user: d.user || '' });
  }

  if (sshParams) {
    try { await connectDbsyncSsh(sshParams); }
    catch (e) { return setStatus({ state: 'failed', stage: 'ssh', error: e.message ?? String(e) }); }
    _lastSshParams = sshParams;
  }
  let res;
  try { res = await initDbsyncDetailed(dbsyncConfig(choice, password), poolHex); }
  catch (e) { res = { ok: false, stage: 'query', error: e.message ?? String(e) }; }
  if (!res.ok) return setStatus({ state: 'failed', stage: res.stage || 'query', error: res.error || 'unknown error' });
  return setStatus({ state: 'ok' });
}

/** One-line description of a status for notices and the DATA tab. */
export function describeDbsyncStatus(st = _status) {
  if (!st || st.state === 'not-configured') return 'db-sync is not set up.';
  if (st.state === 'ok') return 'db-sync connected.';
  if (st.state === 'needs-password') {
    const what = st.need.map((n) => (n === 'passphrase' ? 'the SSH key passphrase' : 'the database password')).join(' and ');
    return `db-sync is set up but needs ${what} for this session.`;
  }
  return `db-sync is set up but failed at the ${STAGE_LABEL[st.stage] || st.stage}: ${st.error}`;
}
