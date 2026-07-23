/**
 * PoolTerminal - Alerts configuration + definitions.
 *
 * Holds the catalogue of available alerts (ALERT_DEFS) and load/save of the
 * user's alert configuration. Config is persisted to the cache meta table via
 * the Rust cache_meta_get/set commands (same store used for other app state),
 * so it survives restarts. An in-memory copy is kept for synchronous reads.
 *
 * The alerts themselves fire from alerts-engine.js, which reads this config.
 */

import { invoke } from './tauri.js';

const META_KEY = 'alerts_config_v1';

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
  try {
    const raw = await invoke('cache_meta_get', { key: META_KEY });
    if (raw) {
      _config = Object.assign(structuredClone(DEFAULT_CONFIG), JSON.parse(raw));
    } else {
      _config = structuredClone(DEFAULT_CONFIG);
    }
  } catch {
    _config = structuredClone(DEFAULT_CONFIG);
  }
  return _config;
}

export function saveAlertConfig(cfg) {
  _config = cfg;
  // fire-and-forget persist
  try {
    invoke('cache_meta_set', { key: META_KEY, value: JSON.stringify(cfg) });
  } catch { /* ignore */ }
}

// Append a fired alert to the recent list (capped) and persist.
export function recordRecentAlert(icon, text) {
  const cfg = getAlertConfig();
  cfg.recent = cfg.recent || [];
  cfg.recent.unshift({ ts: Date.now(), icon, text });
  if (cfg.recent.length > 50) cfg.recent = cfg.recent.slice(0, 50);
  saveAlertConfig(cfg);
}
