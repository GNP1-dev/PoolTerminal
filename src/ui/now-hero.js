/**
 * PoolTerminal — NOW view hero row (8 cards).
 *
 *  Pulse · Epoch · Leader · Ideal · Adopt · Conf · Lost · KES
 *
 * Pulse/Epoch/KES keep their original treatments (delta arrow, progress
 * bar, days countdown). The five Block-Production stats (Leader, Ideal,
 * Adopt, Conf, Lost) are flat label-above-value cells; the standalone
 * "Blocks" hero card has been retired because Adopt now carries the same
 * information with the Luck % rolled into its sub line.
 *
 * Bloomberg-flash fires on discrete change (pulse score, adopted, confirmed),
 * never on continuously-ticking values (epoch progress).
 */

let prev = {};

function byId(id) { return document.getElementById(id); }
function setHTML(id, html) { const el = byId(id); if (el) el.innerHTML = html; }
function setText(id, val) { const el = byId(id); if (el) el.textContent = val; }

function pulseColor(score) {
  if (score >= 85) return 'var(--pt-status-good)';
  if (score >= 60) return 'var(--pt-status-warn)';
  return 'var(--pt-status-bad)';
}
function luckColor(luck) {
  if (luck >= 90) return 'var(--pt-status-good)';
  if (luck >= 70) return 'var(--pt-status-warn)';
  return 'var(--pt-status-bad)';
}
function kesColor(days) {
  if (days < 7) return 'var(--pt-status-bad)';
  if (days < 30) return 'var(--pt-status-warn)';
  return 'var(--pt-text-primary)';
}

function flashCard(cardId, newVal, oldVal) {
  if (oldVal === undefined || newVal === oldVal) return;
  const el = byId(cardId);
  if (!el) return;
  const cls = newVal > oldVal ? 'pt-flash-up' : 'pt-flash-down';
  el.classList.remove('pt-flash-up', 'pt-flash-down');
  void el.offsetWidth; // force reflow so animation restarts
  el.classList.add(cls);
}

export function resetHero() { prev = {}; }

export function renderHero(snap) {
  const bp = snap.blockProduction;
  const pp = snap.poolPulse;

  // --- Pulse ---
  setHTML('hero-pulse-val', `${pp.score}<span class="pt-hero-unit">/100</span>`);
  byId('hero-pulse-val').style.color = pulseColor(pp.score);
  const arrow = pp.delta > 0 ? '▲' : pp.delta < 0 ? '▼' : '·';
  const deltaEl = byId('hero-pulse-delta');
  deltaEl.textContent = `${arrow} ${pp.delta >= 0 ? '+' : ''}${pp.delta}`;
  deltaEl.style.color = pp.delta >= 0 ? 'var(--pt-status-good)' : 'var(--pt-status-bad)';
  flashCard('hero-pulse', pp.score, prev.pulse);

  // --- Epoch (continuous: no flash, smooth bar) ---
  const epPct = (snap.epochProgress * 100).toFixed(1);
  setHTML('hero-epoch-val', `${epPct}<span class="pt-hero-unit">%</span>`);
  byId('hero-epoch-bar').style.width = epPct + '%';

  // --- Leader ---
  setText('hero-leader-val', bp.leader);

  // --- Ideal ---
  setText('hero-ideal-val', bp.ideal);

  // --- Adopt (carries Blocks's old role: count + Luck % in sub) ---
  setText('hero-adopt-val', bp.adopted);
  const luckEl = byId('hero-adopt-sub');
  if (luckEl) {
    luckEl.textContent = `Luck ${bp.luckPercent}%`;
    luckEl.style.color = luckColor(bp.luckPercent);
  }
  flashCard('hero-adopt', bp.adopted, prev.adopted);

  // --- Conf ---
  const confEl = byId('hero-conf-val');
  if (confEl) {
    confEl.textContent = bp.confirmed;
    confEl.style.color = 'var(--pt-status-good)';
  }
  flashCard('hero-conf', bp.confirmed, prev.confirmed);

  // --- Lost (always red — losing a block is always noteworthy) ---
  const lostEl = byId('hero-lost-val');
  if (lostEl) {
    lostEl.textContent = bp.lost;
    lostEl.style.color = 'var(--pt-status-bad)';
  }

  // --- KES ---
  setHTML('hero-kes-val', `${snap.kesDaysRemaining}<span class="pt-hero-unit">d</span>`);
  byId('hero-kes-val').style.color = kesColor(snap.kesDaysRemaining);

  // Progress bar: remaining / 62 periods (mainnet max KES evolutions).
  // Red fill once we're inside the 7-day danger window.
  const KES_MAX_PERIODS = 62;
  const kesPct = Math.max(
    0,
    Math.min(100, (snap.kesPeriodsRemaining / KES_MAX_PERIODS) * 100)
  );
  const kesBar = byId('hero-kes-bar');
  if (kesBar) {
    kesBar.style.width = kesPct + '%';
    kesBar.style.background = snap.kesDaysRemaining < 7
      ? 'var(--pt-status-bad)'
      : 'var(--pt-accent-blue)';
  }

  // Sub line shows the actual expiry datetime, e.g. "23 Aug 14:32"
  const expiry = new Date(Date.now() + snap.kesDaysRemaining * 86400000);
  const dd = String(expiry.getDate()).padStart(2, '0');
  const mmm = expiry.toLocaleString('en-GB', { month: 'short' });
  const hh = String(expiry.getHours()).padStart(2, '0');
  const mm = String(expiry.getMinutes()).padStart(2, '0');
  setText('hero-kes-sub', `${dd} ${mmm} ${hh}:${mm}`);

  prev = {
    pulse: pp.score,
    adopted: bp.adopted,
    confirmed: bp.confirmed,
  };
}
