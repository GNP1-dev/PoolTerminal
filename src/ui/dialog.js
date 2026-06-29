/**
 * PoolTerminal - themed confirm/alert dialogs.
 *
 * Replaces native window.confirm / window.alert (which render as ugly native
 * GTK dialogs under WebKitGTK) with an in-app dialog matching the dark UI.
 *
 *   await confirmDialog({ title, message, confirmLabel, cancelLabel, danger }) -> boolean
 *   await alertDialog({ title, message, confirmLabel, danger })               -> void
 *
 * Esc / backdrop-click = cancel, Enter = confirm. `danger:true` styles the
 * heading + primary button red for destructive actions. `message` supports
 * \n line breaks and is inserted as text (no HTML injection).
 */

function ensureStyle() {
  if (document.getElementById('pt-dialog-style')) return;
  const st = document.createElement('style');
  st.id = 'pt-dialog-style';
  st.textContent = `
    .pt-dlg-backdrop { position: fixed; inset: 0; z-index: 9999; display: flex; align-items: center; justify-content: center;
      background: rgba(6,9,14,0.62); animation: pt-dlg-fade 120ms ease-out; }
    @keyframes pt-dlg-fade { from { opacity: 0; } to { opacity: 1; } }
    .pt-dlg { width: min(420px, calc(100vw - 48px)); background: #121823; border: 1px solid #2a3647; border-radius: 12px;
      box-shadow: 0 18px 60px rgba(0,0,0,0.55); overflow: hidden;
      animation: pt-dlg-pop 140ms cubic-bezier(.2,.9,.3,1.15); }
    @keyframes pt-dlg-pop { from { transform: translateY(8px) scale(.985); opacity: 0; } to { transform: none; opacity: 1; } }
    .pt-dlg-h { font: 700 14px ui-monospace, monospace; color: #e6edf3; padding: 16px 18px 0; }
    .pt-dlg-h.danger { color: #ff7a7a; }
    .pt-dlg-msg { font: 400 12.5px ui-monospace, monospace; color: #b6c2d2; line-height: 1.55;
      padding: 10px 18px 16px; white-space: pre-line; }
    .pt-dlg-actions { display: flex; justify-content: flex-end; gap: 9px; padding: 0 16px 16px; }
    .pt-dlg-btn { font: 600 12.5px ui-monospace, monospace; padding: 8px 16px; border-radius: 8px; cursor: pointer;
      border: 1px solid transparent; transition: background 120ms ease, border-color 120ms ease; }
    .pt-dlg-cancel { background: #1b2430; color: #cdd6e4; border-color: #2c3a4d; }
    .pt-dlg-cancel:hover { background: #232f3f; border-color: #3a4d66; }
    .pt-dlg-ok { background: #2563c9; color: #fff; }
    .pt-dlg-ok:hover { background: #2b6fe0; }
    .pt-dlg-ok.danger { background: #b3322f; }
    .pt-dlg-ok.danger:hover { background: #cc3a36; }
  `;
  document.head.appendChild(st);
}

function buildDialog({ title, message, confirmLabel, cancelLabel, danger, alert }) {
  ensureStyle();
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'pt-dlg-backdrop';
    const actions = alert
      ? `<button class="pt-dlg-btn pt-dlg-ok${danger ? ' danger' : ''}" data-act="ok"></button>`
      : `<button class="pt-dlg-btn pt-dlg-cancel" data-act="cancel"></button>` +
        `<button class="pt-dlg-btn pt-dlg-ok${danger ? ' danger' : ''}" data-act="ok"></button>`;
    back.innerHTML =
      `<div class="pt-dlg" role="dialog" aria-modal="true">` +
        `<div class="pt-dlg-h${danger ? ' danger' : ''}"></div>` +
        `<div class="pt-dlg-msg"></div>` +
        `<div class="pt-dlg-actions">${actions}</div>` +
      `</div>`;
    // Insert text content safely (no HTML injection from messages).
    back.querySelector('.pt-dlg-h').textContent = title || (alert ? 'Notice' : 'Please confirm');
    back.querySelector('.pt-dlg-msg').textContent = message || '';
    const okBtn = back.querySelector('[data-act="ok"]');
    okBtn.textContent = confirmLabel || (alert ? 'OK' : 'Confirm');
    const cancelBtn = back.querySelector('[data-act="cancel"]');
    if (cancelBtn) cancelBtn.textContent = cancelLabel || 'Cancel';

    document.body.appendChild(back);

    const cleanup = () => { document.removeEventListener('keydown', onKey, true); back.remove(); };
    const done = (val) => { cleanup(); resolve(val); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); done(alert ? undefined : false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(alert ? undefined : true); }
    };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('click', (e) => {
      const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
      if (act === 'ok') done(alert ? undefined : true);
      else if (act === 'cancel') done(false);
      else if (e.target === back && !alert) done(false);   // backdrop cancels (confirm only)
    });
    okBtn.focus();
  });
}

export function confirmDialog(opts) { return buildDialog({ ...opts, alert: false }); }
export function alertDialog(opts) { return buildDialog({ ...opts, alert: true }); }
