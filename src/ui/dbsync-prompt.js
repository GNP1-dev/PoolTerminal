/**
 * PoolTerminal - db-sync password / key passphrase prompt (0.4.1).
 *
 * Shown when db-sync is set up but this session lacks the database password
 * (not remembered) or the SSH key passphrase (never stored). Before 0.4.1 the
 * app silently fell back to Koios in that case. The user can enter what is
 * needed, or choose "Not now" (Koios is used; the Delegators and Data tabs
 * keep a button to open this again). (dbsync-status-v1)
 */

import { getDbsyncStatus, setSessionSecrets, savedSourceChoice, SOURCE_CHOICE_KEY, describeDbsyncStatus } from '../data/dbsync-connect.js';
import { retryDbsyncNow } from '../data/read-model.js';

let _dismissed = false;   // "Not now" for this session
let _open = false;

export const REMEMBER_TEXT =
  'Remember so db-sync reconnects after restart (stored unencrypted on this computer - use a read-only role)';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function ensureStyle() {
  if (document.getElementById('pt-dbp-style')) return;
  const st = document.createElement('style');
  st.id = 'pt-dbp-style';
  st.textContent = `
    .pt-dbp-bd { position: fixed; inset: 0; z-index: 9998; display: flex; align-items: center; justify-content: center; background: rgba(6,9,14,0.62); }
    .pt-dbp { width: min(460px, calc(100vw - 48px)); background: #121823; border: 1px solid #2a3647; border-radius: 12px; box-shadow: 0 18px 60px rgba(0,0,0,0.55); padding: 16px 18px; font: 400 13px system-ui, sans-serif; color: #cdd6e4; }
    .pt-dbp h3 { margin: 0 0 8px; font: 700 14px ui-monospace, monospace; color: #e6edf3; }
    .pt-dbp p { margin: 0 0 12px; line-height: 1.5; color: #b6c2d2; }
    .pt-dbp label.f { display: block; margin: 10px 0 4px; font-size: 12.5px; color: #9fb0d0; }
    .pt-dbp input[type=password] { width: 100%; box-sizing: border-box; padding: 8px 10px; background: #0b1119; color: #e6edf3; border: 1px solid #2c3a4d; border-radius: 8px; font: 13px ui-monospace, monospace; }
    .pt-dbp .rem { display: flex; gap: 8px; align-items: flex-start; margin: 8px 0 0; font-size: 13px; color: #cdd6e4; cursor: pointer; }
    .pt-dbp .rem input { margin-top: 3px; }
    .pt-dbp .err { min-height: 18px; margin: 10px 0 0; color: #ff8a80; font-size: 12.5px; }
    .pt-dbp .act { display: flex; justify-content: flex-end; gap: 9px; margin-top: 14px; }
    .pt-dbp button { font: 600 12.5px ui-monospace, monospace; padding: 8px 16px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
    .pt-dbp .no { background: #1b2430; color: #cdd6e4; border-color: #2c3a4d; }
    .pt-dbp .go { background: #2563c9; color: #fff; }
    .pt-dbp .go:disabled { opacity: .5; cursor: wait; }
  `;
  document.head.appendChild(st);
}

/** Open the prompt now (also used by the notices' "Enter password" buttons). */
export function showDbsyncPrompt() {
  const st = getDbsyncStatus();
  if (_open || st.state !== 'needs-password') return;
  _open = true;
  ensureStyle();
  const needPw = st.need.includes('password');
  const needPp = st.need.includes('passphrase');
  const bd = document.createElement('div');
  bd.className = 'pt-dbp-bd';
  bd.innerHTML = `<div class="pt-dbp" role="dialog" aria-modal="true">
    <h3>db-sync needs ${needPw && needPp ? 'a password and a passphrase' : needPp ? 'the SSH key passphrase' : 'the database password'}</h3>
    <p>db-sync is set up, but ${needPw && needPp ? 'neither is' : 'it is not'} available in this session, so PoolTerminal is using Koios for now.</p>
    ${needPp ? `<label class="f" for="pt-dbp-pp">Passphrase for SSH key ${esc(st.keyPath || '')}</label>
      <input id="pt-dbp-pp" type="password" autocomplete="off">` : ''}
    ${needPw ? `<label class="f" for="pt-dbp-pw">Database password${st.user ? ` for role ${esc(st.user)}` : ''}</label>
      <input id="pt-dbp-pw" type="password" autocomplete="off">
      <label class="rem"><input type="checkbox" id="pt-dbp-rem"> <span>${esc(REMEMBER_TEXT)}</span></label>` : ''}
    <div class="err" id="pt-dbp-err"></div>
    <div class="act"><button class="no" id="pt-dbp-no" type="button">Not now</button><button class="go" id="pt-dbp-go" type="button">Connect</button></div>
  </div>`;
  document.body.appendChild(bd);
  const $ = (id) => bd.querySelector(id);
  const close = () => { bd.remove(); _open = false; };
  ($('#pt-dbp-pp') || $('#pt-dbp-pw')).focus();
  $('#pt-dbp-no').addEventListener('click', () => { _dismissed = true; close(); });
  bd.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#pt-dbp-go').click(); if (e.key === 'Escape') $('#pt-dbp-no').click(); });
  $('#pt-dbp-go').addEventListener('click', async () => {
    const pw = needPw ? $('#pt-dbp-pw').value : undefined;
    const pp = needPp ? $('#pt-dbp-pp').value : undefined;
    if ((needPw && !pw) || (needPp && !pp)) { $('#pt-dbp-err').textContent = 'Please fill in the field above.'; return; }
    const go = $('#pt-dbp-go'); go.disabled = true; $('#pt-dbp-err').textContent = 'Connecting...';
    setSessionSecrets({ password: pw, passphrase: pp });
    if (needPw && $('#pt-dbp-rem').checked) {
      try {
        const c = savedSourceChoice();
        if (c && c.dbsync) {
          c.dbsync.password = pw; c.dbsync.savePassword = true;
          localStorage.setItem(SOURCE_CHOICE_KEY, JSON.stringify(c));
        }
      } catch (e) {
        $('#pt-dbp-err').textContent = `Could not remember the password on this computer (${e.message ?? e}); it is used for this session only.`;
      }
    }
    let ok = false;
    try { ok = await retryDbsyncNow(); } catch { ok = false; }
    go.disabled = false;
    if (ok) { close(); return; }
    const now = getDbsyncStatus();
    $('#pt-dbp-err').textContent = describeDbsyncStatus(now);
  });
}

/** Show the prompt automatically once per session when a password is needed. */
export function installDbsyncPrompt(isLive) {
  window.addEventListener('pt:dbsync-status', (e) => {
    const st = e.detail || {};
    // Never over the setup wizard: its own Test reports what is missing inline.
    if (document.getElementById('wz-modal')) return;
    if (st.state === 'needs-password' && !_dismissed && (!isLive || isLive())) showDbsyncPrompt();
  });
}
