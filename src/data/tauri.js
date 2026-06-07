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
import { getTransport } from './session.js';

export function invoke(cmd, args) {
  const inv = window.__TAURI__?.core?.invoke;
  if (!inv) {
    throw new Error('Tauri runtime not available (window.__TAURI__.core.invoke missing).');
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
