/**
 * PoolTerminal — cardano-cli runner with per-command timeouts.
 *
 * Every cardano-cli query the app runs goes through runCli(), which wraps the
 * cli in coreutils `timeout` on the node. Without it a hung query waits forever:
 * cardano-cli 11.1.0.0-11.2.2.0 against node 11.0.x never returns from
 * `query tip` / `kes-period-info` (cardano-cli#1434), and the fast loop's
 * in-flight guard then freezes the dashboard with no error at all.
 *
 * The timeouts are defined HERE and nowhere else. Measured on the BP with
 * docs/audit/timing-bp.sh (node 11.1.2 / cli 11.2.3.0, 2026-09-25; see finding
 * A10 in docs/audit/node-11.1.2-compat-2026-09-24.md), slowest of 3 runs: tip 14 ms, mempool 15 ms, kes-period-info 25 ms, stake-snapshot
 * 15 ms. 3x those is well under a second, so every value below is a floor
 * chosen for slow hosts and busy nodes, not a measurement. leadership-schedule
 * cannot be timed without the VRF signing key, so it gets the fix plan's
 * 300 s floor.
 */
// cli-timeouts-v1

import { invoke } from './tauri.js';
import { getSession } from './session.js';

export const CLI_TIMEOUT_TIP_S                 = 10;
export const CLI_TIMEOUT_MEMPOOL_S             = 10;
export const CLI_TIMEOUT_KES_S                 = 20;
export const CLI_TIMEOUT_STAKE_SNAPSHOT_S      = 30;
export const CLI_TIMEOUT_LEADERSHIP_SCHEDULE_S = 300;

const TIMEOUT_EXIT = 124;   // coreutils `timeout` exit code when it killed the command

/** Thrown when `timeout` killed a cli query. `label` names the query. */
export class CliTimeoutError extends Error {
  constructor(label, seconds) {
    super(
      `cardano-cli ${label} timed out after ${seconds} s. ` +
      `This usually means a cardano-cli / cardano-node version mismatch ` +
      `(e.g. cli 11.1.0.0-11.2.2.0 against node 11.0.x waits forever). ` +
      `Check both versions on the node.`
    );
    this.name = 'CliTimeoutError';
    this.label = label;
    this.seconds = seconds;
  }
}

/** The shell command for one cli query, bounded by `timeout`. */
export function cliCmd(args, timeoutS) {
  const e = getSession().envVars || {};
  return `CARDANO_NODE_SOCKET_PATH=${e.CARDANO_NODE_SOCKET_PATH} timeout ${timeoutS} ` +
    `${e.CCLI} ${args} ${e.NETWORK_IDENTIFIER || '--mainnet'}`;
}

// Flags whose value is a key or cert file. Their paths never reach a log line or
// an error message: cardano-cli's stderr names the file when it can't read it,
// and runCli's errors are logged and shown in the UI. /*no-key-paths-v1*/
const KEY_FLAGS = ['--op-cert-file', '--vrf-signing-key-file'];
const KEY_FILE_RE = /(?:\/|~\/|\.\/)?[\w.\-\/]*\.(?:skey|vkey|cert|counter)\b/g;

/**
 * Replace key and cert file paths in `text` with <key file>: first the exact
 * paths passed to KEY_FLAGS in `args`, then anything shaped like a key file
 * (*.skey, *.vkey, *.cert, *.counter).
 */
export function redactKeyPaths(text, args = '') {
  let out = String(text ?? '');
  for (const flag of KEY_FLAGS) {
    const re = new RegExp(`${flag}\\s+(?:'([^']*)'|"([^"]*)"|(\\S+))`, 'g');
    for (const m of String(args).matchAll(re)) {
      const p = m[1] ?? m[2] ?? m[3];
      if (p) out = out.split(p).join('<key file>');
    }
  }
  return out.replace(KEY_FILE_RE, '<key file>');
}

/**
 * Run one cli query and return its stdout. `label` is the query as an operator
 * would name it ("query tip"); it goes into the timeout message. Throws
 * CliTimeoutError on exit 124, and a plain Error for any other non-zero exit.
 */
export async function runCli(label, args, timeoutS) {
  const r = await invoke('ssh_run', { command: cliCmd(args, timeoutS) });
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    if (r.exit_code === TIMEOUT_EXIT) throw new CliTimeoutError(label, timeoutS);
    if (typeof r.exit_code === 'number' && r.exit_code !== 0) {
      throw new Error(`ssh_run exit ${r.exit_code}: ${redactKeyPaths(r.stderr || r.stdout || '', args).slice(0, 400)}`);
    }
    return r.stdout ?? '';
  }
  return String(r);
}
