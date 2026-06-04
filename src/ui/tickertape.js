/**
 * PoolTerminal — tickertape binding.
 * Renders a NowSnapshot into the persistent top strip. The strip is global
 * chrome (visible on every view), so it's driven by the always-on poll loop
 * in main.js, not by any single view.
 *
 * Layout (left to right):
 *   POOL [Role] · NET·ERA · EPOCH · BLOCK · SYNC · KES · PEERS · LIVE/DEMO
 *
 * BLOCK replaces the old SLOT slot — block height changes once per ~20s
 * and is visibly "alive", whereas absolute slot ticks 1/sec on a 9-digit
 * number which is hard to see.
 *
 * FORGING dot has been retired: redundant with the Role badge.
 */

import { commas } from './format.js';

function byId(id) { return document.getElementById(id); }
function setText(id, val) {
  const el = byId(id);
  if (el) el.textContent = val;
}

// KES is a countdown to a required action: neutral when plenty of time,
// amber as it approaches, red when urgent.
function kesColor(days) {
  if (days < 7) return 'var(--pt-status-bad)';
  if (days < 30) return 'var(--pt-status-warn)';
  return 'var(--pt-text-primary)';
}

export function renderTickertape(snap) {
  const nameEl = document.querySelector('.pt-ticker-name');
  if (nameEl) nameEl.textContent = snap.poolTicker;

  // NET · ERA (combined slot)
  const netEraEl = byId('ttape-net');
  if (netEraEl) {
    const net = snap.network || '—';
    const era = snap.era || '';
    netEraEl.textContent = era ? `${net} · ${era}` : net;
  }

  setText('ttape-epoch', snap.epoch);
  setText('ttape-block', snap.tipBlock != null ? commas(snap.tipBlock) : '—');

  const syncEl = byId('ttape-sync');
  if (syncEl) {
    syncEl.textContent = snap.syncPercent.toFixed(1) + '%';
    syncEl.style.color =
      snap.atTip && snap.syncPercent >= 99.95
        ? 'var(--pt-status-good)'
        : 'var(--pt-status-warn)';
  }

  const kesEl = byId('ttape-kes');
  if (kesEl) {
    if (snap.kesDaysRemaining == null) {
      kesEl.textContent = '—';
      kesEl.style.color = 'var(--pt-text-muted)';
    } else {
      kesEl.textContent = snap.kesDaysRemaining + 'd';
      kesEl.style.color = kesColor(snap.kesDaysRemaining);
    }
  }

  // Peers in live mode are painted directly by setPeerCounts (Prometheus);
  // demo mode supplies non-null fields here.
  if (snap.peersOut != null && snap.peersIn != null) {
    setText('ttape-peers', `${snap.peersOut}/${snap.peersIn}`);
  }
}

/** Dim the whole strip when data is stale (DESIGN.md §8: 60% opacity). */
export function markTickertapeStale(isStale) {
  const el = byId('pt-tickertape');
  if (el) el.classList.toggle('pt-stale', isStale);
}

/**
 * Set the role badge next to the pool name.
 * role: 'BP' | 'RELAY' | 'UNKNOWN' | null (hides)
 */
export function setRoleBadge(role) {
  const el = byId('ttape-role');
  if (!el) return;
  if (!role) {
    el.style.display = 'none';
    el.className = 'pt-ticker-role';
    el.textContent = '';
    return;
  }
  const labels = { BP: 'Block Producer', RELAY: 'Relay', UNKNOWN: 'Unknown' };
  el.style.display = '';
  el.textContent = labels[role] || role;
  el.className = 'pt-ticker-role pt-role-' + role.toLowerCase();
}

/**
 * Paint the PEERS slot directly. Format: "out/in".
 * Called by the peers-query poll (live mode); demo mode uses snap-based render.
 */
export function setPeerCounts(out, inb) {
  if (out == null || inb == null) {
    setText('ttape-peers', '—');
    return;
  }
  setText('ttape-peers', `${out}/${inb}`);
}
