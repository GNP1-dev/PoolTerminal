/**
 * PoolTerminal — Tauri 2 invoke shim.
 *
 * No bundler, so we go via the global `window.__TAURI__.core.invoke` that
 * Tauri 2 injects. Throws clearly when run in a plain browser (e.g. devtools
 * outside Tauri) so failures are easy to read.
 */
export function invoke(cmd, args) {
  const inv = window.__TAURI__?.core?.invoke;
  if (!inv) {
    throw new Error('Tauri runtime not available (window.__TAURI__.core.invoke missing).');
  }
  return inv(cmd, args);
}
