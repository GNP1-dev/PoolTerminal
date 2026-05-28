/**
 * PoolTerminal — NOW view hero row.
 * Four metric cards (Pulse / Epoch / Blocks / KES) bound to a NowSnapshot.
 * Bloomberg-flash fires only on discrete changes (pulse score, blocks adopted),
 * never on continuously-ticking values (epoch progress).
 */

let prev = {};

function byId(id) {
  return document.getElementById(id);
}
function setHTML(id, html) {
  const el = byId(id);
  if (el) el.innerHTML = html;
}
function setText(id, val) {
  const el = byId(id);
  if (el) el.textContent = val;
}

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

// Restart the flash animation on a card when a tracked value changes.
function flashCard(cardId, newVal, oldVal) {
  if (oldVal === undefined || newVal === oldVal) return;
  const el = byId(cardId);
  if (!el) return;
  const cls = newVal > oldVal ? 'pt-flash-up' : 'pt-flash-down';
  el.classList.remove('pt-flash-up', 'pt-flash-down');
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add(cls);
}

/** Called by the view on (re)mount so a fresh mount doesn't spuriously flash. */
export function resetHero() {
  prev = {};
}

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

  // --- Blocks (flash when a new block is adopted) ---
  setHTML('hero-blocks-val', `${bp.adopted}<span class="pt-hero-unit">/${bp.ideal}</span>`);
  const blkSub = byId('hero-blocks-sub');
  blkSub.textContent = `Luck ${bp.luckPercent}%`;
  blkSub.style.color = luckColor(bp.luckPercent);
  flashCard('hero-blocks', bp.adopted, prev.adopted);

  // --- KES (value + colour only; changes ~once/day) ---
  setHTML('hero-kes-val', `${snap.kesDaysRemaining}<span class="pt-hero-unit">d</span>`);
  byId('hero-kes-val').style.color = kesColor(snap.kesDaysRemaining);
  setText('hero-kes-sub', `${snap.kesPeriodsRemaining} periods`);

  prev = { pulse: pp.score, adopted: bp.adopted };
}
