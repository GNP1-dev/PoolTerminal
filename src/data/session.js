/**
 * PoolTerminal — Session state and connection config persistence.
 *
 * What we persist (localStorage, host machine):
 *   host, port, user, envFile, authOrder
 * What we NEVER persist:
 *   password, OTP code, env contents
 *
 * The env probe runs once on connect and populates STATE.envVars with the
 * key paths from the user's Guild env file. live.js reads from there.
 */

const CONFIG_KEY = 'poolterminal.connection.v1';

const STATE = {
  connected: false,
  transport: 'ssh',   // 'ssh' (remote node) | 'local' (PT runs on the node)
  host: null,
  port: null,
  user: null,
  envFile: null,
  authOrder: null,
  envVars: {},   // { CCLI, CARDANO_NODE_SOCKET_PATH, CNCLI_DB, NETWORK_NAME, ... }
  nodeProbe: null,  // { role, pid, port, topologyPath, args } once probed
};

export function getSession() { return STATE; }
export function isConnected() { return STATE.connected; }
export function getTransport() { return STATE.transport || 'ssh'; }
export function setTransport(mode) { STATE.transport = (mode === 'local') ? 'local' : 'ssh'; }

export function setNodeProbe(probe) { STATE.nodeProbe = probe; }
export function getNodeProbe() { return STATE.nodeProbe; }

export function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function saveConfig(conn) {
  // Read what we already remembered so local mode can't clobber remote details.
  let prev = {};
  try { prev = JSON.parse(localStorage.getItem(CONFIG_KEY)) || {}; } catch { prev = {}; }
  const isLocal = conn.transport === 'local';
  // Sanitised — no creds. In local mode the host is always "localhost", which
  // must NOT overwrite the remembered remote host/port/user, or a later SSH
  // connect would target localhost and be refused. Preserve the prior remote
  // values when saving a local session.
  const safe = {
    transport: conn.transport || 'ssh',
    host: isLocal ? (prev.host || null) : conn.host,
    port: isLocal ? (prev.port || null) : conn.port,
    user: isLocal ? (prev.user || conn.user) : conn.user,
    envFile: conn.envFile,
    authOrder: conn.authOrder,
    authMethod: conn.authMethod,
    keyPath: conn.keyPath,
  };
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(safe));
  } catch (e) {
    console.warn('saveConfig failed:', e);
  }
}

export function markConnected(conn, envVars) {
  STATE.connected = true;
  STATE.transport = conn.transport || 'ssh';
  STATE.host = conn.host;
  STATE.port = conn.port;
  STATE.user = conn.user;
  STATE.envFile = conn.envFile;
  STATE.authOrder = conn.authOrder;
  STATE.envVars = envVars;
}

export function markDisconnected() {
  STATE.connected = false;
  STATE.transport = 'ssh';
  STATE.envVars = {};
  STATE.nodeProbe = null;
}
