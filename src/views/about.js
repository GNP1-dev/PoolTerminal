/**
 * PoolTerminal - ABOUT / how it works.
 *
 * Plain-language explanation of what PoolTerminal does and where its data comes
 * from: the node + internet baseline (Koios), and what the optional db-sync and
 * Blockfrost sources add. Personalised with the operator's current active
 * sources (read from the registry) so it reflects their real setup, then the
 * general explanation. Reachable from Settings.
 */

import { registry, DataKind } from '../data/capabilities.js';
import { getMode } from '../data/index.js';

const APP_VERSION = '0.1.0';

function safeReach(s) { try { return s.reachable(); } catch { return false; } }

function currentSetupHtml() {
  const live = getMode() === 'live';
  const dbsync = registry.all().find((s) => s.id === 'dbsync');
  const dbsyncOn = dbsync && safeReach(dbsync);
  const koiosOn = registry.all().some((s) => (s.id === 'koios' || s.id === 'koios-live') && safeReach(s));
  const bf = registry.all().find((s) => s.id === 'blockfrost');
  const bfOn = bf && safeReach(bf);

  const chip = (cls, label, on) =>
    `<span class="ab-chip ${on ? '' : 'ab-chip-off'}"><span class="ab-dot ${cls}"></span>${label}</span>`;

  return `<div class="ab-setup">
    <div class="ab-setup-h">Your current setup</div>
    <div class="ab-chips">
      ${chip('ab-node', live ? 'Node connected' : 'Node not connected', live)}
      ${chip('ab-koios', koiosOn ? 'Koios' : 'Koios unavailable', koiosOn)}
      ${chip('ab-dbsync', dbsyncOn ? 'db-sync' : 'db-sync off', dbsyncOn)}
      ${chip('ab-bf', bfOn ? 'Blockfrost' : 'Blockfrost off', bfOn)}
    </div>
    <div class="ab-setup-note">Change sources anytime from the gear (Settings), top-right, or by running setup again.</div>
  </div>`;
}

const SECTIONS = `
  <div class="ab-sec">
    <h3>What PoolTerminal does</h3>
    <p>PoolTerminal is a live dashboard for your Cardano stake pool: block production, delegators,
    node health and on-chain notifications, in one place. It runs on your own machine and talks
    directly to your node - nothing is stored on anyone else's servers.</p>
  </div>

  <div class="ab-sec">
    <h3>The baseline: your node + internet</h3>
    <p>All PoolTerminal needs to be useful is access to your node (locally or over SSH) and an internet
    connection. With just those it reads everything live from the node - chain tip, sync, KES, blocks,
    leader schedule, peers, mempool and host health - and uses <span class="ab-src ab-koios">Koios</span>,
    a free public Cardano service, for pool summary, delegators, history and notifications.</p>
    <p>That alone is a complete setup, and it's all most operators need.</p>
  </div>

  <div class="ab-sec">
    <h3>Optional: add db-sync</h3>
    <p>If you run your own <span class="ab-src ab-dbsync">db-sync</span> database, PoolTerminal can read
    from it directly. It adds the <strong>loyalty leaderboard</strong> (longest-tenured delegators, which
    only db-sync can compute), full instant per-epoch history, and the delegator deep-dive - all with no
    API limits, straight from your own data.</p>
  </div>

  <div class="ab-sec">
    <h3>Optional: add Blockfrost</h3>
    <p>A free <span class="ab-src ab-bf">Blockfrost</span> project key is another way to get the pool
    summary, delegator list and delegator deep-dive - useful if you want richer delegator data without
    running db-sync. Enter the key in Settings.</p>
  </div>

  <div class="ab-sec">
    <h3>Who serves what</h3>
    <p>PoolTerminal picks the best available source for each piece of data automatically. When more than
    one source can answer, it prefers db-sync (your own data, instant), then Koios, then Blockfrost. You
    can see exactly which source is answering each feature on the <strong>Data</strong> tab.</p>
    <ul class="ab-list">
      <li>Live node data - always from your node.</li>
      <li>History and pool parameters - db-sync or Koios.</li>
      <li>Pool summary and notifications - Koios (or Blockfrost for the summary).</li>
      <li>Delegator list and deep-dive - db-sync, Koios or Blockfrost.</li>
      <li>Loyalty leaderboard - db-sync only.</li>
    </ul>
  </div>

  <div class="ab-sec ab-sec-amber">
    <h3>Keeping up to date</h3>
    <p>PoolTerminal depends on your node and (optionally) db-sync. When a Cardano <strong>hard fork</strong>
    happens, you'll need to upgrade your node and db-sync, and sometimes PoolTerminal itself. If numbers
    look wrong after a fork, check those are all up to date.</p>
  </div>
`;

function ensureStyle() {
  if (document.getElementById('ab-style')) return;
  const el = document.createElement('style');
  el.id = 'ab-style';
  el.textContent = `
    .ab-wrap { flex: 1 1 auto; min-height: 0; overflow-y: auto; box-sizing: border-box; padding: 6px 4px 28px; max-width: 760px; }
    .ab-wrap h2 { font-size: 21px; font-weight: 800; margin: 0 0 4px; color: var(--pt-text-primary, #e6edf3); }
    .ab-tagline { font-size: 13px; color: var(--pt-text-muted, #9aa7b4); margin: 0 0 18px; }
    .ab-setup { border: 1px solid rgba(120,150,190,0.2); border-radius: 11px; padding: 14px 16px; margin-bottom: 22px;
      background: rgba(120,150,190,0.05); }
    .ab-setup-h { font-size: 11px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--pt-text-muted, #9aa7b4); margin-bottom: 10px; }
    .ab-chips { display: flex; flex-wrap: wrap; gap: 8px; }
    .ab-chip { display: inline-flex; align-items: center; gap: 7px; padding: 6px 12px; border-radius: 20px;
      font-size: 12.5px; font-weight: 600; background: rgba(120,150,190,0.08); border: 1px solid rgba(120,150,190,0.2);
      color: var(--pt-text-primary, #e6edf3); }
    .ab-chip-off { opacity: 0.5; }
    .ab-dot { width: 8px; height: 8px; border-radius: 50%; }
    .ab-dot.ab-node { background: #4ade80; } .ab-dot.ab-koios { background: #4aa3ff; }
    .ab-dot.ab-dbsync { background: #2dd4bf; } .ab-dot.ab-bf { background: #a78bfa; }
    .ab-setup-note { font-size: 11.5px; color: var(--pt-text-muted, #9aa7b4); margin-top: 11px; }
    .ab-sec { margin-bottom: 20px; }
    .ab-sec h3 { font-size: 14px; font-weight: 700; color: var(--pt-text-primary, #e6edf3); margin: 0 0 7px; }
    .ab-sec p { font-size: 13px; line-height: 1.6; color: var(--pt-text-secondary, #b9c4d0); margin: 0 0 8px; }
    .ab-list { margin: 6px 0 0; padding-left: 18px; }
    .ab-list li { font-size: 12.5px; line-height: 1.7; color: var(--pt-text-secondary, #b9c4d0); }
    .ab-src { font-weight: 700; padding: 1px 7px; border-radius: 12px; font-size: 12px; border: 1px solid; white-space: nowrap; }
    .ab-koios { color: #4aa3ff; border-color: rgba(74,163,255,0.4); background: rgba(74,163,255,0.1); }
    .ab-dbsync { color: #2dd4bf; border-color: rgba(45,212,191,0.4); background: rgba(45,212,191,0.1); }
    .ab-bf { color: #a78bfa; border-color: rgba(167,139,250,0.4); background: rgba(167,139,250,0.1); }
    .ab-sec-amber { border-left: 2px solid rgba(251,191,36,0.4); padding-left: 12px; }
    .ab-sec-amber h3 { color: #fbbf24; }
    .ab-foot { font-size: 11px; color: var(--pt-text-muted, #9aa7b4); opacity: 0.7; margin-top: 18px; font-family: ui-monospace, monospace; }
  `;
  document.head.appendChild(el);
}

export function mountAbout(canvas) {
  ensureStyle();
  canvas.innerHTML =
    `<div class="ab-wrap">` +
      `<h2>About PoolTerminal</h2>` +
      `<div class="ab-tagline">How it works, and where your data comes from.</div>` +
      currentSetupHtml() +
      SECTIONS +
      `<div class="ab-foot">App version ${APP_VERSION}</div>` +
    `</div>`;
}

export function unmountAbout() { /* static view */ }
