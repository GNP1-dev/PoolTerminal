/**
 * PoolTerminal — Tauri 2 invoke shim.
 *
 * No bundler, so we go via the global `window.__TAURI__.core.invoke` that
 * Tauri 2 injects. Throws clearly when run in a plain browser (e.g. devtools
 * outside Tauri) so failures are easy to read.
 *
 * NODE TRANSPORT SEAM (architecture §4): every node command goes through
 * `invoke('ssh_run', …)`. When PoolTerminal runs ON the node (transport
 * 'local'), there's no SSH — so the shim transparently routes `ssh_run` to the
 * Rust `local_run` command, which returns the identical shape. This means none
 * of the ~10 collectors need to change: they keep calling ssh_run, and it just
 * works whether the node is local or remote. `nodeExec` is the explicit form of
 * the same routing for new code.
 */
import { getTransport, isConnected } from './session.js';

// DEMO-ISOLATION BACKSTOP. /*demo-world-v99*/
// While demo mode is active the app must touch nothing real: no node commands,
// no Postgres, no Koios, no Telegram. Every demo screen is fed by
// demo-world.js, so no legitimate demo code path reaches these commands — this
// guard exists so a missed seam FAILS LOUDLY instead of silently querying a
// real node into a screen labelled DEMO. Node commands (ssh_run/local_run) are
// blocked only when a live session also exists: that is the dangerous
// switched-to-demo state, and it exempts the connect flow, which probes the
// node moments before setMode('live'). The mode getter is injected from
// main.js to keep this module import-cycle-free.
const DEMO_BLOCKED = new Set(['pg_query', 'pg_query_ssh', 'pg_query_ssh_via', 'koios_http', 'telegram_send', 'relay_ssh_run']);
const DEMO_BLOCKED_NODE = new Set(['ssh_run', 'local_run']);
let _modeGetter = null;
export function setInvokeModeGate(fn) { _modeGetter = typeof fn === 'function' ? fn : null; }
function demoBlocked(cmd) {
  try {
    if (!_modeGetter || _modeGetter() !== 'demo') return false;
    if (DEMO_BLOCKED.has(cmd)) return true;
    return DEMO_BLOCKED_NODE.has(cmd) && isConnected();
  } catch { return false; }
}

export function invoke(cmd, args) {
  // Audit hook: set `window.__ptInvokeLog = []` (devtools or a test harness)
  // and every command name that passes the shim is recorded — used to prove
  // the demo-isolation rule ("no real command runs in demo"). /*demo-world-v99*/
  if (Array.isArray(window.__ptInvokeLog)) window.__ptInvokeLog.push(cmd);
  const inv = window.__TAURI__?.core?.invoke;
  if (!inv) {
    throw new Error('Tauri runtime not available (window.__TAURI__.core.invoke missing).');
  }
  if (demoBlocked(cmd)) {
    return Promise.reject(new Error(`demo mode: '${cmd}' blocked (demo touches nothing real)`));
  }
  // Route node command execution to the active transport.
  if (cmd === 'ssh_run' && getTransport() === 'local') {
    return inv('local_run', args);
  }
  return inv(cmd, args);
}

/** Explicit node-exec seam (same routing as the ssh_run interception above). */
export function nodeExec(command) {
  return invoke('ssh_run', { command });
}

// Packaged app version, straight from the Tauri runtime (core app plugin, the
// version field in tauri.conf.json). The ONLY source of the displayed version:
// hardcoded strings in src drifted at every release (About showed 0.3.0 on a
// 0.3.1 build, the wizard still said 0.1.0). Resolved once, cached; a failed
// resolve returns '' and retries on the next call. /*app-version-v94*/
let _appVerPromise = null;
export function getAppVersion() {
  if (!_appVerPromise) {
    _appVerPromise = Promise.resolve()
      .then(() => invoke('plugin:app|version'))
      .then((v) => String(v || ''))
      .catch(() => { _appVerPromise = null; return ''; });
  }
  return _appVerPromise;
}
