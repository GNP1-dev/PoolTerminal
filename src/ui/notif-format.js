/**
 * PoolTerminal — notification event formatting.
 *
 * Pure display helpers shared by the toast (ui/toast.js) and the NOTIFICATIONS
 * view, so both render an event identically. No DOM, no side effects.
 *
 * Event shape (from read-model.refreshNotifications / cache):
 *   { type, stake, detail: { amount, delta?, fromPool?, fromTicker?,
 *                            toPool?, toTicker?, epoch? }, capturedAt? }
 * `amount` and `delta` are lovelace.
 */

/** Lovelace → "12,450.32 ₳" (thousands separators, up to 2 dp, trims zeros). */
export function fmtAda(lovelace) {
  if (lovelace == null) return '—';
  const ada = Number(lovelace) / 1_000_000;
  return ada.toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' ₳';
}

/** "stake1u9c4ch0…6kg7na" — head + tail, for compact display. */
export function shortStake(s) {
  if (!s) return '—';
  return s.length > 18 ? `${s.slice(0, 11)}…${s.slice(-5)}` : s;
}

/** A pool's display label: ticker if we resolved one, else a short id. */
function poolLabel(ticker, poolId) {
  if (ticker) return ticker;
  if (!poolId) return 'another pool';
  return poolId.length > 14 ? `${poolId.slice(0, 9)}…${poolId.slice(-4)}` : poolId;
}

// Our own pool's ticker, set once we know it (from the live snapshot in main.js).
// Lets every line name the pool the change relates to, with direction.
let _ownTicker = null;
export function setOwnPoolTicker(t) { if (t) _ownTicker = t; }
export function getOwnPoolTicker() { return _ownTicker; }

/**
 * Turn an event into { icon, title, line, tone }.
 *   tone: 'pos' (gain/join) | 'neg' (loss/leave) | 'neutral'
 */
export function formatNotifEvent(ev, ownTicker) {
  const d = ev.detail || {};
  const who = shortStake(ev.stake);
  const amt = fmtAda(d.amount);
  const own = ownTicker || _ownTicker || 'your pool';

  switch (ev.type) {
    case 'join':
      return { icon: '🟢', title: 'New delegator', tone: 'pos',
               line: `${who} · ${amt} → ${own}` };

    case 'join_redelegated':
      return { icon: '🟢', title: 'New delegator', tone: 'pos',
               line: `${who} · ${amt} · ${poolLabel(d.fromTicker, d.fromPool)} → ${own}` };

    case 'join_returning':
      return { icon: '🔄', title: 'Returning delegator', tone: 'pos',
               line: `${who} · ${amt} · ${poolLabel(d.fromTicker, d.fromPool)} → ${own}` };

    case 'stake_up':
      return { icon: '🔼', title: 'Stake added', tone: 'pos',
               line: `${who} · +${fmtAda(Math.abs(d.delta))} → ${amt} · ${own}` };

    case 'stake_down':
      return { icon: '🔽', title: 'Stake reduced', tone: 'neg',
               line: `${who} · −${fmtAda(Math.abs(d.delta))} → ${amt} · ${own}` };

    case 'leave_redelegated':
      return { icon: '↪️', title: 'Redelegated away', tone: 'neg',
               line: `${who} · was ${amt} · ${own} → ${poolLabel(d.toTicker, d.toPool)}` };

    case 'leave_to_wallet':
      return { icon: '👋', title: 'Undelegated', tone: 'neg',
               line: `${who} · was ${amt} · left ${own}` };

    case 'leave':
      return { icon: '👋', title: 'Left pool', tone: 'neg',
               line: `${who} · was ${amt} · left ${own}` };

    default:
      return { icon: '•', title: ev.type || 'Change', tone: 'neutral',
               line: `${who} · ${amt} · ${own}` };
  }
}

/** Unix seconds → "just now" / "4m ago" / "2h ago" / "3d ago". */
export function relTime(unixSec) {
  if (!unixSec) return '';
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSec);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
