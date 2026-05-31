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
  // Sanitised — no creds
  const safe = {
    host: conn.host,
    port: conn.port,
    user: conn.user,
    envFile: conn.envFile,
    authOrder: conn.authOrder,
  };
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(safe));
  } catch (e) {
    console.warn('saveConfig failed:', e);
  }
}

export function markConnected(conn, envVars) {
  STATE.connected = true;
  STATE.host = conn.host;
  STATE.port = conn.port;
  STATE.user = conn.user;
  STATE.envFile = conn.envFile;
  STATE.authOrder = conn.authOrder;
  STATE.envVars = envVars;
}

export function markDisconnected() {
  STATE.connected = false;
  STATE.envVars = {};
  STATE.nodeProbe = null;
}
