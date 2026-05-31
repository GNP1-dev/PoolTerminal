/**
 * PoolTerminal — tickertape binding.
 * Renders a NowSnapshot into the persistent top strip. The strip is global
 * chrome (visible on every view), so it's driven by the always-on poll loop in
 * main.js, not by any single view.
 */

import { commas } from './format.js';

function byId(id) {
  return document.getElementById(id);
}
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

function renderForging(forging) {
  const el = byId('ttape-forging');
  if (!el) return;
  el.innerHTML = forging
    ? '<span class="pt-dot pt-dot-good"></span>' +
      '<span class="pt-ticker-val" style="color: var(--pt-status-good)">FORGING</span>'
    : '<span class="pt-dot pt-dot-bad"></span>' +
      '<span class="pt-ticker-val" style="color: var(--pt-status-bad)">NOT FORGING</span>';
}

export function renderTickertape(snap) {
  const nameEl = document.querySelector('.pt-ticker-name');
  if (nameEl) nameEl.textContent = snap.poolTicker;

  setText('ttape-epoch', snap.epoch);
  setText('ttape-slot', commas(snap.slot));

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
    kesEl.textContent = snap.kesDaysRemaining + 'd';
    kesEl.style.color = kesColor(snap.kesDaysRemaining);
  }

  // peers shown OUT/IN (matches the approved NOW-view mock)
  setText('ttape-peers', `${snap.peersOut}/${snap.peersIn}`);

  renderForging(snap.forging);
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
  el.style.display = '';
  el.textContent = role;
  el.className = 'pt-ticker-role pt-role-' + role.toLowerCase();
}
