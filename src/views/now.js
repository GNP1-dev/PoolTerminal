/**
 * PoolTerminal — NOW view.
 * Mounts the NOW dashboard into the canvas and updates it from each poll.
 * Panels are added per Phase-1 step; currently: hero row.
 */

import { renderHero, resetHero } from '../ui/now-hero.js';

const NOW_HTML = `
  <div class="pt-now">
    <div class="pt-hero-row">
      <div class="pt-hero-card" id="hero-pulse">
        <div class="pt-hero-label">Pulse</div>
        <div class="pt-hero-value" id="hero-pulse-val">—<span class="pt-hero-unit">/100</span></div>
        <div class="pt-hero-sub" id="hero-pulse-delta">—</div>
      </div>
      <div class="pt-hero-card" id="hero-epoch">
        <div class="pt-hero-label">Epoch</div>
        <div class="pt-hero-value" id="hero-epoch-val">—<span class="pt-hero-unit">%</span></div>
        <div class="pt-hero-bar"><div class="pt-hero-bar-fill" id="hero-epoch-bar"></div></div>
      </div>
      <div class="pt-hero-card pt-hero-accent" id="hero-blocks">
        <div class="pt-hero-label">Blocks</div>
        <div class="pt-hero-value" id="hero-blocks-val">—<span class="pt-hero-unit">/—</span></div>
        <div class="pt-hero-sub" id="hero-blocks-sub">—</div>
      </div>
      <div class="pt-hero-card" id="hero-kes">
        <div class="pt-hero-label">KES</div>
        <div class="pt-hero-value" id="hero-kes-val">—<span class="pt-hero-unit">d</span></div>
        <div class="pt-hero-sub" id="hero-kes-sub">—</div>
      </div>
    </div>
    <!-- chain pulse / upcoming blocks / mempool / map: later steps -->
  </div>`;

export function mountNow(canvas) {
  canvas.innerHTML = NOW_HTML;
  resetHero();
}

export function updateNow(snap) {
  renderHero(snap);
}
