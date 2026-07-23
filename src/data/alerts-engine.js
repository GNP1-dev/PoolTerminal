/**
 * PoolTerminal - Alerts engine.
 *
 * Called once per poll cycle with the latest data the app already has. For each
 * ENABLED alert it evaluates the condition, applies debounce/cooldown + quiet
 * hours, and sends a Telegram message via the Rust `telegram_send` command.
 *
 * Design: this is deliberately DEFENSIVE - each check reads the data it needs
 * from the passed context and simply skips if that data isn't present this
 * cycle (e.g. mempool not yet polled). So a missing field never throws; the
 * alert just doesn't fire until the data is there. State (last values, last
 * fire times) is kept module-local across cycles.
 *
 * Alerts only fire while PoolTerminal is open - by design (the target user runs
 * the app on an always-on machine, so no block-producer agent is needed).
 */

import { invoke } from './tauri.js';
import { getAlertConfig, recordRecentAlert, ALERT_DEFS } from './alerts-config.js';

// --- module state (persists across cycles while app is open) ---------------
const lastFired = {};        // { [alertId]: epochMs }  cooldown tracking
const armed = {};            // { [alertId]: bool }  edge-trigger arming
let lastTipBlock = null;     // for block-minted + stall
let lastTipChangeMs = Date.now();
let lastPoolAdopted = null;  // for block-minted (our pool's block count)
let started = false;

const ICONS = Object.fromEntries(ALERT_DEFS.map((d) => [d.id, d.icon]));
const NAMES = Object.fromEntries(ALERT_DEFS.map((d) => [d.id, d.name]));
const SEV   = Object.fromEntries(ALERT_DEFS.map((d) => [d.id, d.severity]));

export function startAlertsEngine() { started = true; }

// --- Telegram send ---------------------------------------------------------
async function send(cfg, id, text) {
  const token = cfg.telegram?.token, chatId = cfg.telegram?.chatId;
  if (!token || !chatId) return;
  const icon = ICONS[id] || '\uD83D\uDD14';
  const full = `${icon} <b>${NAMES[id] || 'PoolTerminal'}</b>\n${text}`;
  try {
    await invoke('telegram_send', {
      token, method: 'sendMessage',
      body: JSON.stringify({ chat_id: chatId, text: full, parse_mode: 'HTML' }),
    });
    recordRecentAlert(icon, text);
  } catch { /* network hiccup - will retry on next trigger */ }
}

// cooldown + quiet-hours gate. Returns true if we may fire now.
function mayFire(cfg, id) {
  const now = Date.now();
  const cd = (cfg.cooldownMin || 15) * 60000;
  if (lastFired[id] && now - lastFired[id] < cd) return false;
  // quiet hours mute non-critical alerts
  if (cfg.quietHours?.enabled && SEV[id] !== 'critical') {
    if (inQuietHours(cfg.quietHours.from, cfg.quietHours.to)) return false;
  }
  return true;
}
function fire(cfg, id, text) {
  lastFired[id] = Date.now();
  send(cfg, id, text);
}
function inQuietHours(from, to) {
  const [fh, fm] = (from || '23:00').split(':').map(Number);
  const [th, tm] = (to || '07:00').split(':').map(Number);
  const d = new Date();
  const cur = d.getHours() * 60 + d.getMinutes();
  const a = fh * 60 + fm, b = th * 60 + tm;
  return a <= b ? (cur >= a && cur < b) : (cur >= a || cur < b);  // handles overnight wrap
}

function isOn(cfg, id) { return !!cfg.alerts?.[id]?.enabled; }
function thr(cfg, id, fallback) { return cfg.alerts?.[id]?.threshold ?? fallback; }

/**
 * Run all enabled checks. Call once per poll cycle.
 * @param ctx {
 *   snap:         latest NOW snapshot (tipBlock, poolTicker, kes..., adopted...),
 *   kesDays:      number | null  KES days remaining (if known),
 *   mempool:      { congestionPct, blocks } | null,
 *   peers:        number | null  connected peer count,
 *   slowBlock:    { delay } | null  a just-captured slow block this cycle,
 * }
 */
export function runAlertChecks(ctx) {
  if (!started) return;
  const cfg = getAlertConfig();
  if (!cfg.telegram?.token || !cfg.telegram?.chatId) return;   // not connected
  const now = Date.now();
  const snap = ctx.snap || {};

  // --- track tip for block-minted + stall ---
  const tip = snap.tipBlock;
  if (tip != null) {
    if (lastTipBlock != null && tip !== lastTipBlock) lastTipChangeMs = now;
    if (lastTipBlock == null) lastTipChangeMs = now;
  }

  // === BLOCK MINTED === (our pool's adopted count increased) ===============
  if (isOn(cfg, 'block_minted')) {
    const adopted = snap.adopted ?? snap.confirmed ?? null;
    if (adopted != null) {
      if (lastPoolAdopted != null && adopted > lastPoolAdopted) {
        const n = adopted - lastPoolAdopted;
        // block minted is a celebration - bypass cooldown but respect quiet hours
        if (!(cfg.quietHours?.enabled && inQuietHours(cfg.quietHours.from, cfg.quietHours.to))) {
          send(cfg, 'block_minted', n === 1
            ? 'Your pool just forged a block! \uD83C\uDF89'
            : `Your pool just forged ${n} blocks! \uD83C\uDF89`);
        }
      }
      lastPoolAdopted = adopted;
    }
  }

  // === KES EXPIRY === (days remaining crosses a configured warn threshold) ==
  if (isOn(cfg, 'kes_expiry') && ctx.kesDays != null) {
    const def = ALERT_DEFS.find((d) => d.id === 'kes_expiry');
    const days = cfg.alerts.kes_expiry?.days ?? def.threshold.default;
    // fire when kesDays is at or below any configured warn-day (once per day-bucket)
    const hit = days.filter((wd) => ctx.kesDays <= wd).sort((a, b) => a - b)[0];
    if (hit != null) {
      const key = 'kes_expiry_' + hit;
      if (!armed[key]) {
        armed[key] = true;
        if (mayFire(cfg, 'kes_expiry')) {
          fire(cfg, 'kes_expiry',
            `KES key expires in ${Math.floor(ctx.kesDays)} day(s). Time to plan a rotation.`);
        }
      }
    }
  }

  // === NODE STALL === (tip hasn't advanced for N minutes) ==================
  if (isOn(cfg, 'node_stall') && tip != null) {
    const mins = thr(cfg, 'node_stall', 10);
    const stalledMs = now - lastTipChangeMs;
    if (stalledMs >= mins * 60000) {
      if (!armed.node_stall && mayFire(cfg, 'node_stall')) {
        armed.node_stall = true;
        fire(cfg, 'node_stall',
          `Tip has not advanced for ${Math.floor(stalledMs / 60000)} minutes. Node may be stuck or unreachable.`);
      }
    } else {
      armed.node_stall = false;   // re-arm once it recovers
    }
  }

  // === MEMPOOL FULL === (network congestion >= threshold) ==================
  if (isOn(cfg, 'mempool_full') && ctx.mempool && ctx.mempool.congestionPct != null) {
    const at = thr(cfg, 'mempool_full', 100);
    if (ctx.mempool.congestionPct >= at) {
      if (!armed.mempool_full && mayFire(cfg, 'mempool_full')) {
        armed.mempool_full = true;
        fire(cfg, 'mempool_full',
          `Mempool at ${Math.round(ctx.mempool.congestionPct)}% of the network's 2-block limit.`);
      }
    } else if (ctx.mempool.congestionPct < at * 0.8) {
      armed.mempool_full = false;  // re-arm with hysteresis (drop below 80% of threshold)
    }
  }

  // === LOW PEERS === (connected peers below threshold) =====================
  if (isOn(cfg, 'peers_low') && ctx.peers != null) {
    const floor = thr(cfg, 'peers_low', 3);
    if (ctx.peers < floor) {
      if (!armed.peers_low && mayFire(cfg, 'peers_low')) {
        armed.peers_low = true;
        fire(cfg, 'peers_low', `Connected peers dropped to ${ctx.peers} (below ${floor}).`);
      }
    } else if (ctx.peers >= floor) {
      armed.peers_low = false;
    }
  }

  // === SLOW PROPAGATION === (a block this cycle exceeded the delay threshold) =
  if (isOn(cfg, 'slow_block') && ctx.slowBlock && ctx.slowBlock.delay != null) {
    const over = thr(cfg, 'slow_block', 2);
    if (ctx.slowBlock.delay >= over) {
      if (mayFire(cfg, 'slow_block')) {
        fire(cfg, 'slow_block',
          `Your block took ${ctx.slowBlock.delay.toFixed(1)}s to propagate (over ${over}s).`);
      }
    }
  }

  lastTipBlock = tip ?? lastTipBlock;
}
