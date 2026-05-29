/**
 * PoolTerminal — Block production panel.
 * 6-cell grid for this epoch:  LEADER · IDEAL · LUCK  /  ADOPT · CONF · LOST
 * Flashes Adopt/Conf cells when a new block lands (celebration).
 */

let prev = {};

function byId(id) { return document.getElementById(id); }
function setText(id, v) { const el = byId(id); if (el) el.textContent = v; }

function luckColor(luck) {
  if (luck >= 90) return 'var(--pt-status-good)';
  if (luck >= 70) return 'var(--pt-status-warn)';
  return 'var(--pt-status-bad)';
}

function flash(cellId, newVal, oldVal) {
  if (oldVal === undefined || newVal === oldVal) return;
  const el = byId(cellId);
  if (!el) return;
  const cls = newVal > oldVal ? 'pt-flash-up' : 'pt-flash-down';
  el.classList.remove('pt-flash-up', 'pt-flash-down');
  void el.offsetWidth;
  el.classList.add(cls);
}

export function resetBlockProduction() {
  prev = {};
}

export function renderBlockProduction(bp) {
  setText('bp-leader', bp.leader);
  setText('bp-ideal', bp.ideal);

  const luckEl = byId('bp-luck');
  if (luckEl) {
    luckEl.textContent = bp.luckPercent + '%';
    luckEl.style.color = luckColor(bp.luckPercent);
  }

  setText('bp-adopt', bp.adopted);
  const confEl = byId('bp-conf');
  if (confEl) {
    confEl.textContent = bp.confirmed;
    confEl.style.color = 'var(--pt-status-good)';
  }
  const lostEl = byId('bp-lost');
  if (lostEl) {
    lostEl.textContent = bp.lost;
    lostEl.style.color = bp.lost > 0 ? 'var(--pt-status-bad)' : 'var(--pt-text-primary)';
  }

  flash('bp-cell-adopt', bp.adopted, prev.adopted);
  flash('bp-cell-conf', bp.confirmed, prev.confirmed);

  prev = { adopted: bp.adopted, confirmed: bp.confirmed };
}
