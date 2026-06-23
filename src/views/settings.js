/**
 * PoolTerminal - Settings modal.
 *
 * A single, top-level settings dialog opened from the ⚙ in the tickertape. It is
 * organised into sections; the first is NOTIFICATIONS (poll cadence + stake
 * threshold, with a tier-aware advisor). This same shell is the basis for the
 * first-run setup wizard - each section here becomes a wizard step.
 *
 * Reuses the .pt-modal styling and the WebKitGTK-safe select/option treatment
 * proven in the connect dialog (explicit -webkit-text-fill-color + option bg).
 */

import { registry, DataKind } from '../data/capabilities.js';
import { showSetupWizard } from './wizard.js';
import { applyBlockfrostKey, blockfrostStatus, reverifyBlockfrost } from '../data/read-model.js';
import {
  getNotifSettings, saveNotifSettings, getNotifSource,
  suggestPollMs, pollUsage, fmtInterval, POLL_LADDER_MS,
} from '../data/notif-settings.js';

const MODAL_HTML = `
<div class="pt-modal-backdrop" id="set-modal">
  <div class="pt-modal pt-modal-settings">
    <div class="pt-modal-header">
      <div class="pt-modal-title">Settings</div>
      <div class="pt-modal-sub">Preferences are stored locally on this machine.</div>
    </div>
    <style>
.pt-modal-settings { max-width: 560px; }
.pt-modal-settings .pt-modal-header { padding: 10px 18px; }
.pt-modal-settings .pt-modal-body { padding: 10px 18px; gap: 7px; }
.pt-modal-settings .pt-modal-actions { padding: 9px 18px; }
.set-section { border-top: 1px solid rgba(120,150,190,0.18); padding: 9px 0 2px; }
.set-section:first-of-type { border-top: 0; }
.set-section-title { font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.07em; color: var(--pt-text-primary, #e6edf3); margin-bottom: 8px; }
.set-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
.set-label { flex: 0 0 150px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--pt-text-muted, #9aa7b4); }
.set-val { font-size: 13px; font-weight: 600; color: var(--pt-text-primary, #e6edf3); }
.set-hint { font-size: 11.5px; color: var(--pt-text-muted, #9aa7b4); line-height: 1.4; padding-left: 160px; margin: -3px 0 6px; }
.set-hint.set-warn { color: #fb7185; }
.pt-modal-settings input,
.pt-modal-settings select {
  background-color: #0e1620 !important; color: #ffffff !important;
  -webkit-text-fill-color: #ffffff !important;
  border: 1px solid rgba(120,150,190,0.5) !important; border-radius: 4px !important;
  padding: 7px 9px !important; font: 600 13px ui-monospace, monospace !important;
}
.pt-modal-settings select {
  -webkit-appearance: none !important; -moz-appearance: none !important; appearance: none !important;
  background-color: #16202e !important;
  background-image: linear-gradient(45deg, transparent 50%, #9fb4cc 50%), linear-gradient(135deg, #9fb4cc 50%, transparent 50%) !important;
  background-position: right 14px center, right 9px center !important;
  background-size: 5px 5px, 5px 5px !important; background-repeat: no-repeat, no-repeat !important;
  padding-right: 28px !important; cursor: pointer !important;
}
.pt-modal-settings select option { background-color: #0e1620 !important; color: #ffffff !important; -webkit-text-fill-color: #ffffff !important; }
.pt-modal-settings input[type="number"] { width: 120px; }
.set-unit { font-size: 12px; color: var(--pt-text-muted, #9aa7b4); }
.set-btn { cursor: pointer; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600; border: 1px solid rgba(120,150,190,0.4); background: transparent; color: var(--pt-text-primary, #e6edf3); }
.set-btn:hover { border-color: var(--pt-accent-blue, #4aa3ff); }
@media (max-width: 640px) { .set-hint { padding-left: 0; } .set-label { flex-basis: 100%; } }
    </style>
    <div class="pt-modal-body" id="set-body"></div>
    <div class="pt-modal-actions">
      <button class="pt-btn" id="set-close">Close</button>
      <button class="pt-btn pt-btn-primary" id="set-save">Save</button>
      <span class="set-saved" id="set-saved" style="display:none; color:#4ade80; font-weight:600; font-size:12px; align-self:center;">Saved \u2713</span>
    </div>
  </div>
</div>`;

function notifSectionHtml() {
  const s = getNotifSettings();
  const source = getNotifSource() || 'koios';
  const isDbsync = source === 'dbsync';
  const srcLabel = isDbsync ? 'db-sync (no API limits)' : source === 'blockfrost' ? 'Blockfrost' : 'Koios';
  const intervalOpts = POLL_LADDER_MS
    .map((ms) => `<option value="${ms}" ${ms === s.pollMs ? 'selected' : ''}>${fmtInterval(ms)}</option>`).join('');
  const tierSel = (t) => (s.koiosTier === t ? 'selected' : '');
  const thresholdAda = s.thresholdLovelace / 1e6;
  return (
    `<div class="set-section">` +
      `<div class="set-section-title">Notifications</div>` +
      `<div class="set-row"><span class="set-label">Live source</span><span class="set-val" id="set-src">${srcLabel}</span></div>` +
      `<div class="set-row set-tier-row"${isDbsync ? ' style="display:none"' : ''}>` +
        `<span class="set-label">Koios tier</span>` +
        `<select id="set-tier">` +
          `<option value="free" ${tierSel('free')}>Free \u00b7 no key \u00b7 5k/day</option>` +
          `<option value="token" ${tierSel('token')}>Registered token \u00b7 50k/day</option>` +
        `</select></div>` +
      `<div class="set-row"><span class="set-label">Poll interval</span>` +
        `<select id="set-interval">${intervalOpts}</select>` +
        `<button class="set-btn" id="set-suggest" type="button">Use suggested</button></div>` +
      `<div class="set-hint" id="set-reason"></div>` +
      `<div class="set-row"><span class="set-label">Stake-change threshold</span>` +
        `<input id="set-threshold" type="number" min="0" step="1" value="${thresholdAda}"><span class="set-unit">ADA</span></div>` +
      `<div class="set-hint" id="set-usage"></div>` +
    `</div>`
  );
}

let _delegCount = 0;

function recompute(root) {
  const q = (id) => root.querySelector(id);
  const source = getNotifSource() || 'koios';
  const tier = q('#set-tier') ? q('#set-tier').value : 'free';
  const intervalMs = Number(q('#set-interval') && q('#set-interval').value) || getNotifSettings().pollMs;

  const sug = suggestPollMs({ delegatorCount: _delegCount, source, koiosTier: tier });
  if (q('#set-reason')) q('#set-reason').textContent = `Suggested ${fmtInterval(sug.ms)} \u2014 ${sug.reason}`;
  if (q('#set-suggest')) q('#set-suggest').dataset.ms = String(sug.ms);

  const usage = pollUsage({ ms: intervalMs, delegatorCount: _delegCount, source, koiosTier: tier });
  const u = q('#set-usage');
  if (u) {
    if (usage.budget === Infinity) { u.textContent = 'No API budget applies with db-sync.'; u.classList.remove('set-warn'); }
    else {
      let t = `At ${fmtInterval(intervalMs)}: ~${usage.callsPerDay.toLocaleString()} Koios calls/day of ${usage.budget.toLocaleString()} allowed.`;
      if (usage.breaches) t += ' Over budget \u2014 choose a longer interval, a registered token, or db-sync.';
      u.textContent = t;
      u.classList.toggle('set-warn', usage.breaches);
    }
  }
}

function dbsyncStateText() {
  try {
    const s = registry.all().find((x) => x.id === 'dbsync');
    if (s && s.reachable && s.reachable()) {
      const v = (() => { try { return s.version(); } catch { return null; } })();
      return v ? `Active - schema ${v}` : 'Active';
    }
  } catch { /* ignore */ }
  return 'Not configured';
}

export function showSettingsModal() {
  if (document.getElementById('set-modal')) return;   // already open
  const wrap = document.createElement('div');
  wrap.innerHTML = MODAL_HTML;
  const modal = wrap.firstElementChild;
  document.body.appendChild(modal);

  const bf = (() => { try { return blockfrostStatus(); } catch { return { configured: false, healthy: false }; } })();
  const bfState = bf.configured ? (bf.healthy ? 'Active' : 'Key set, not reachable - check it') : 'Not configured';

  modal.querySelector('#set-body').innerHTML = notifSectionHtml() +
    `<div class="set-section">` +
      `<div class="set-section-title">Data sources</div>` +
      `<div class="set-row"><span class="set-label">Koios</span><span class="set-val">Always on - public API</span></div>` +
      `<div class="set-row"><span class="set-label">db-sync</span><span class="set-val" id="set-dbsync-state">${dbsyncStateText()}</span></div>` +
      `<div class="set-hint">db-sync is set up in the wizard - it adds full instant history and the loyalty leaderboard.</div>` +
      `<div class="set-row"><span class="set-label">Blockfrost</span><span class="set-val" id="set-bf-state">${bfState}</span></div>` +
      `<div class="set-row"><span class="set-label">Project key</span>` +
        `<input id="set-bf-key" type="password" placeholder="mainnet..." value="" autocomplete="off">` +
        `<button class="set-btn" id="set-bf-save" type="button">Save</button>` +
        `<button class="set-btn" id="set-bf-remove" type="button">Remove</button></div>` +
      `<div class="set-hint">A mainnet project key from blockfrost.io. Adds the delegator deep-dive and pool lifecycle. Stored locally on this machine; leave blank and Save to keep the current key.</div>` +
      `<div class="set-hint" id="set-bf-msg"></div>` +
    `</div>` +
    `<div class="set-section">` +
      `<div class="set-section-title">Setup</div>` +
      `<div class="set-row"><span class="set-label">First-run wizard</span>` +
        `<button class="set-btn" id="set-rerun" type="button">Run setup again</button></div>` +
      `<div class="set-hint">Walk through connection, data sources and notifications again. Your current settings stay until you finish and save.</div>` +
      `<div class="set-row"><span class="set-label">How it works</span>` +
        `<button class="set-btn" id="set-about" type="button">About / data sources</button></div>` +
      `<div class="set-hint">A plain-language explanation of what PoolTerminal does and where its data comes from.</div>` +
    `</div>`;

  const close = () => modal.remove();
  modal.querySelector('#set-close').addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  modal.querySelector('#set-rerun').addEventListener('click', () => { close(); showSetupWizard(); });
  modal.querySelector('#set-about').addEventListener('click', () => { close(); window.dispatchEvent(new CustomEvent('pt-open-about')); });

  // Blockfrost key management
  const bfMsg = (t, warn) => { const el = modal.querySelector('#set-bf-msg'); if (el) { el.textContent = t; el.classList.toggle('set-warn', !!warn); } };
  const setBfState = (ok, configured) => {
    const el = modal.querySelector('#set-bf-state');
    if (el) el.textContent = configured ? (ok ? 'Active' : 'Key set, not reachable - check it') : 'Not configured';
  };
  modal.querySelector('#set-bf-save').addEventListener('click', async () => {
    const input = modal.querySelector('#set-bf-key');
    const key = input ? input.value.trim() : '';
    try {
      if (key) {
        bfMsg('Checking key against Blockfrost...');
        const ok = await applyBlockfrostKey(key);
        setBfState(ok, true);
        bfMsg(ok ? 'Blockfrost activated.' : 'Saved, but Blockfrost did not respond as healthy - check the key.', !ok);
        if (input) input.value = '';
      } else if (bf.configured) {
        // Blank + Save with a key already stored = re-verify the existing key.
        bfMsg('Re-checking the saved key...');
        const ok = await reverifyBlockfrost();
        setBfState(ok, true);
        bfMsg(ok ? 'Blockfrost is reachable.' : 'The saved key did not respond as healthy - check it or paste a new one.', !ok);
      } else {
        bfMsg('Enter a project key to save, or use Remove to clear it.', true);
      }
    } catch (e) { bfMsg('Could not verify the key: ' + (e.message ?? e), true); }
  });
  modal.querySelector('#set-bf-remove').addEventListener('click', async () => {
    try { await applyBlockfrostKey(''); } catch { /* ignore */ }
    setBfState(false, false);
    bfMsg('Blockfrost key removed. The deep-dive needs db-sync or a Blockfrost key.');
  });
  // Note: opening Settings does NOT re-probe a working key (a flaky health check
  // must never knock a reachable source offline). Use Save to re-verify on demand.

  // Pull the live delegator count for the advisor, then refresh the lines.
  recompute(modal);
  registry.get(DataKind.POOL_LIVE)
    .then((live) => { if (live && live.liveDelegators != null) { _delegCount = live.liveDelegators; recompute(modal); } })
    .catch(() => {});

  ['#set-tier', '#set-interval'].forEach((id) => {
    const el = modal.querySelector(id);
    if (el) el.addEventListener('change', () => recompute(modal));
  });
  modal.querySelector('#set-suggest').addEventListener('click', () => {
    const ms = Number(modal.querySelector('#set-suggest').dataset.ms);
    const sel = modal.querySelector('#set-interval');
    if (ms && sel) { sel.value = String(ms); recompute(modal); }
  });

  modal.querySelector('#set-save').addEventListener('click', () => {
    const tier = modal.querySelector('#set-tier') ? modal.querySelector('#set-tier').value : 'free';
    const pollMs = Number(modal.querySelector('#set-interval').value) || getNotifSettings().pollMs;
    const ada = parseFloat(modal.querySelector('#set-threshold').value);
    const thresholdLovelace = (Number.isFinite(ada) && ada >= 0) ? Math.round(ada * 1e6) : getNotifSettings().thresholdLovelace;
    saveNotifSettings({ koiosTier: tier, pollMs, thresholdLovelace });
    const saved = modal.querySelector('#set-saved');
    if (saved) { saved.style.display = 'inline'; setTimeout(() => { saved.style.display = 'none'; }, 2000); }
  });
}
