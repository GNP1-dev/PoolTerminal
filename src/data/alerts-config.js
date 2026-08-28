/**
 * PoolTerminal - Alerts configuration + definitions.
 *
 * Holds the catalogue of available alerts (ALERT_DEFS) and load/save of the
 * user's alert configuration. Config is persisted to localStorage - the same
 * store as the Koios token and Blockfrost key - because this is USER
 * configuration, not pool data: it used to live in the cache meta table, and
 * every cache reset (the old blanket clear on Disconnect) silently deleted
 * the Telegram token and every alert toggle, killing the bot on the next app
 * launch. Keeping it out of the cache entirely means no future cache-clearing
 * routine can take it out again by accident. A one-time migration below
 * rescues any config still sitting in the meta table of a pre-v102 install.
 * An in-memory copy is kept for synchronous reads. (alerts-cfg-store-v102)
 *
 * The alerts themselves fire from alerts-engine.js, which reads this config.
 */

import { invoke } from './tauri.js';
import { getMode } from './index.js';   /*alerts-demo-blank-v103*/

const META_KEY = 'alerts_config_v1';               // legacy location (cache meta), read once for migration
const LS_KEY = 'poolterminal.alerts.v1';           // canonical location

// Catalogue of alerts. Each fires from data the app already receives, so no new
// node queries are needed. severity drives the card accent + quiet-hours rules.
export const ALERT_DEFS = [
  {
    id: 'kes_expiry',
    name: 'KES expiry',
    icon: '\uD83D\uDD11',
    severity: 'critical',
    desc: 'Warn before your KES key expires and needs rotating.',
    sample: 'KES key expires in 7 days - time to rotate.',
    threshold: { type: 'days-chips', options: [14, 7, 3, 1], default: [7, 1] },
  },
  {
    id: 'node_stall',
    name: 'Node stall',
    icon: '\u26A0\uFE0F',
    severity: 'critical',
    desc: 'Alert when the tip stops advancing (node stuck or unreachable).',
    sample: 'Tip has not advanced for 10 minutes.',
    threshold: { type: 'number', label: 'After', default: 10, min: 2, max: 120, unit: 'min' },
  },
  {
    id: 'block_minted',
    name: 'Block minted',
    icon: '\u26CF\uFE0F',
    severity: 'info',
    desc: 'Celebrate each block your pool forges.',
    sample: 'Your pool just forged a block! \uD83C\uDF89',
  },
  {
    id: 'slow_block',
    name: 'Slow propagation',
    icon: '\uD83D\uDC22',
    severity: 'important',
    desc: 'Alert when one of your blocks propagates slower than a threshold.',
    sample: 'Your block took 4.8s to propagate (over 2s).',
    threshold: { type: 'number', label: 'Over', default: 2, min: 1, max: 20, unit: 's' },
  },
  {
    id: 'mempool_full',
    name: 'Mempool full',
    icon: '\uD83D\uDCE6',
    severity: 'info',
    desc: 'Alert when the network mempool reaches its 2-block limit.',
    sample: 'Mempool is full - the network is at capacity.',
    threshold: { type: 'number', label: 'At', default: 100, min: 50, max: 200, unit: '%' },
  },
  {
    id: 'peers_low',
    name: 'Low peers',
    icon: '\uD83D\uDD0C',
    severity: 'important',
    desc: 'Alert when connected peer count drops below a threshold.',
    sample: 'Connected peers dropped to 2.',
    threshold: { type: 'number', label: 'Below', default: 3, min: 1, max: 50, unit: 'peers' },
  },
];

const DEFAULT_CONFIG = {
  telegram: { token: '', chatId: '' },
  alerts: {},          // { [id]: { enabled, threshold?, days? } }
  cooldownMin: 15,
  quietHours: { enabled: false, from: '23:00', to: '07:00' },
  recent: [],          // [{ ts, icon, text }]
};

let _config = null;

// Synchronous getter - returns the in-memory config (load() populates it at
// startup). Falls back to defaults if not yet loaded.
export function getAlertConfig() {
  if (!_config) _config = structuredClone(DEFAULT_CONFIG);
  return _config;
}

export async function loadAlertConfig() {
  let raw = null;
  try { raw = localStorage.getItem(LS_KEY); } catch { raw = null; }
  if (!raw) {
    // One-time migration from the legacy cache-meta location (pre-v102).
    // If the cache was already wiped there is nothing to rescue - the user
    // re-enters their bot token once. /*alerts-cfg-store-v102*/
    try {
      raw = await invoke('cache_meta_get', { key: META_KEY });
      if (raw) {
        try { localStorage.setItem(LS_KEY, raw); } catch { /* keep going */ }
        console.log('[alerts] config migrated from cache meta to localStorage');
      }
    } catch { raw = null; }
  }
  try {
    _config = raw
      ? Object.assign(structuredClone(DEFAULT_CONFIG), JSON.parse(raw))
      : structuredClone(DEFAULT_CONFIG);
  } catch {
    _config = structuredClone(DEFAULT_CONFIG);
  }
  return _config;
}

export function saveAlertConfig(cfg) {
  // Demo hands the Alerts view a throwaway blank config so real credentials
  // never render on a demo screen - a save from that view must not clobber
  // the user's REAL config (in memory or on disk). /*alerts-demo-blank-v103*/
  try { if (getMode() === 'demo') return; } catch { /* fall through */ }
  _config = cfg;
  try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

// Append a fired alert to the recent list (capped) and persist.
export function recordRecentAlert(icon, text) {
  const cfg = getAlertConfig();
  cfg.recent = cfg.recent || [];
  cfg.recent.unshift({ ts: Date.now(), icon, text });
  if (cfg.recent.length > 50) cfg.recent = cfg.recent.slice(0, 50);
  saveAlertConfig(cfg);
}
