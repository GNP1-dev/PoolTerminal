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
  if (pp.score == null) {
    setHTML('hero-pulse-val', '—');
    byId('hero-pulse-val').style.color = 'var(--pt-text-muted)';
    const deltaEl = byId('hero-pulse-delta');
    if (deltaEl) { deltaEl.textContent = ''; }
  } else {
    setHTML('hero-pulse-val', `${pp.score}<span class="pt-hero-unit">/100</span>`);
    byId('hero-pulse-val').style.color = pulseColor(pp.score);
    const arrow = pp.delta > 0 ? '▲' : pp.delta < 0 ? '▼' : '·';
    const deltaEl = byId('hero-pulse-delta');
    deltaEl.textContent = `${arrow} ${pp.delta >= 0 ? '+' : ''}${pp.delta}`;
    deltaEl.style.color = pp.delta >= 0 ? 'var(--pt-status-good)' : 'var(--pt-status-bad)';
    flashCard('hero-pulse', pp.score, prev.pulse);
  }

  // --- Epoch (continuous: no flash, smooth bar) ---
  const epPct = (snap.epochProgress * 100).toFixed(1);
  setHTML('hero-epoch-val', `${epPct}<span class="pt-hero-unit">%</span>`);
  byId('hero-epoch-bar').style.width = epPct + '%';

  // --- Leader / Ideal / Adopt / Conf / Lost ---
  setText('hero-leader-val', bp.leader);
  setText('hero-ideal-val', bp.ideal);
  setText('hero-adopt-val', bp.adopted);
  const luckEl = byId('hero-adopt-sub');
  if (luckEl) {
    luckEl.textContent = `Luck ${bp.luckPercent}%`;
    luckEl.style.color = luckColor(bp.luckPercent);
  }
  flashCard('hero-adopt', bp.adopted, prev.adopted);

  const confEl = byId('hero-conf-val');
  if (confEl) {
    confEl.textContent = bp.confirmed;
    confEl.style.color = 'var(--pt-status-good)';
  }
  flashCard('hero-conf', bp.confirmed, prev.confirmed);

  const lostEl = byId('hero-lost-val');
  if (lostEl) {
    lostEl.textContent = bp.lost;
    lostEl.style.color = 'var(--pt-status-bad)';
  }

  // --- KES ---
  const kesVal = byId('hero-kes-val');
  const kesBar = byId('hero-kes-bar');
  const kesSub = byId('hero-kes-sub');
  if (snap.kesDaysRemaining == null) {
    if (kesVal) { kesVal.innerHTML = '—'; kesVal.style.color = 'var(--pt-text-muted)'; }
    if (kesBar) { kesBar.style.width = '0%'; }
    if (kesSub) { kesSub.textContent = 'no op.cert'; }
  } else {
    setHTML('hero-kes-val', `${snap.kesDaysRemaining}<span class="pt-hero-unit">d</span>`);
    kesVal.style.color = kesColor(snap.kesDaysRemaining);
    const KES_MAX_PERIODS = 62;
    const kesPct = Math.max(
      0,
      Math.min(100, (snap.kesPeriodsRemaining / KES_MAX_PERIODS) * 100)
    );
    if (kesBar) {
      kesBar.style.width = kesPct + '%';
      kesBar.style.background = snap.kesDaysRemaining < 7
        ? 'var(--pt-status-bad)'
        : 'var(--pt-accent-blue)';
    }
    // Use the exact expiry unix timestamp from the cli when available,
    // otherwise fall back to "now + days" (less precise — rounded down).
    const expiry = snap.kesKeyExpiryUnix != null
      ? new Date(snap.kesKeyExpiryUnix * 1000)
      : new Date(Date.now() + snap.kesDaysRemaining * 86400000);
    const dd   = String(expiry.getDate()).padStart(2, '0');
    const mmm  = expiry.toLocaleString('en-GB', { month: 'short' });
    const yyyy = expiry.getFullYear();
    const hh   = String(expiry.getHours()).padStart(2, '0');
    const mm   = String(expiry.getMinutes()).padStart(2, '0');
    const periods = snap.kesPeriodsRemaining != null
      ? `${snap.kesPeriodsRemaining}p · `
      : '';
    setText('hero-kes-sub', `${periods}${dd} ${mmm} ${yyyy} ${hh}:${mm}`);
  }

  prev = {
    pulse: pp.score,
    adopted: bp.adopted,
    confirmed: bp.confirmed,
  };
}
