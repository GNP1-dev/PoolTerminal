/**
 * PoolTerminal — Postgres transport (architecture note §4).
 *
 * Thin JS wrapper over the Rust `pg_query` command. The Rust side picks the
 * connection mode from the params:
 *   • no host           → local Unix socket, peer auth   (PT + db-sync same box)
 *   • host+port+user+pw → remote TCP                      (db-sync on another box)
 * So this one transport serves every db-sync topology; the config decides.
 *
 * CONTRACT: callers MUST cast every selected column to ::text in their SQL.
 * db-sync's big numeric domains exceed i64/f64 and can't be mapped cleanly —
 * text preserves full precision. Returned values are strings (or null); the
 * caller casts to Number/BigInt as needed.
 */

import { invoke } from './tauri.js';

/**
 * Feature flag: SSH-tunnelled Postgres - for a db-sync that only listens on the
 * remote machine's own localhost (not exposed over the network). OFF until the
 * tunnel is validated on a second machine. While false: the wizard never offers
 * tunnel mode, and pgQuery never routes to it, so the working local-socket and
 * direct-TCP paths are the only ones reachable.
 */
export const SSH_TUNNEL_ENABLED = false;

/**
 * Run a read-only SQL statement against db-sync.
 * @param {object} conn  { database, host?, port?, user?, password?, viaSsh? }
 * @param {string} sql   SELECT with all columns cast to ::text
 * @returns {Promise<object[]>}  rows as plain objects keyed by column name
 */
export async function pgQuery(conn, sql) {
  // Route through the SSH tunnel only when explicitly flagged AND the feature is
  // enabled. `viaSsh` is a JS-only hint; strip it before sending to Rust (the
  // PgConn struct has no such field).
  const useTunnel = SSH_TUNNEL_ENABLED && !!(conn && conn.viaSsh === true);
  const { viaSsh, ...pgConn } = conn || {};
  let res;
  try {
    res = await invoke(useTunnel ? 'pg_query_ssh' : 'pg_query', { conn: pgConn, sql });
  } catch (err) {
    // Rust returns a string error (connect/query failure).
    throw new Error(typeof err === 'string' ? err : (err?.message ?? 'pg_query failed'));
  }
  const { columns, rows } = res || {};
  if (!Array.isArray(columns) || !Array.isArray(rows)) return [];
  return rows.map((r) => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = r[i] ?? null; });   // null stays null
    return obj;
  });
}

/** Reachability probe — true if a trivial query succeeds. */
export async function pgReachable(conn) {
  try {
    const rows = await pgQuery(conn, 'SELECT 1::text AS ok');
    return rows.length === 1 && rows[0].ok === '1';
  } catch {
    return false;
  }
}
