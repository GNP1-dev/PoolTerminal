/**
 * PoolTerminal - ALERTS view.
 *
 * Telegram alerting that runs while PoolTerminal is open (the target user runs
 * the app on an always-on GUI machine, so "while open" is effectively always).
 * No agent, no block-producer install: alerts are driven from data the app
 * already receives each poll cycle, and delivered to Telegram via the bot the
 * user creates.
 *
 * This file is the CONFIG surface: a guided setup wizard (create bot -> connect
 * -> test), the per-alert toggle cards, and behaviour settings. The actual
 * condition-checking + firing lives in alerts-engine.js.
 *
 * Telegram calls go through the Rust `telegram_send` command so the bot token
 * travels as a real HTTPS header — never on a command line on the node, and
 * never in a process list. It IS rendered into the setup field (masked, with an
 * explicit show/hide) and IS persisted unencrypted via cache_meta_set, because
 * alerts have to survive a restart; the field carries a note saying so. Its
 * blast radius is the bot itself — it cannot reach the node, keys or funds.
 * See SECURITY.md, "What is stored on disk". tg-disclose-v81
 */

import { invoke } from '../data/tauri.js';
import {
  getAlertConfig, saveAlertConfig, ALERT_DEFS,
} from '../data/alerts-config.js';

let mounted = false;

// ---- Telegram API helpers (via Rust) --------------------------------------

async function tg(token, method, bodyObj) {
  const raw = await invoke('telegram_send', {
    token,
    method,
    body: bodyObj ? JSON.stringify(bodyObj) : null,
  });
  try { return JSON.parse(raw); } catch { return { ok: false, description: 'Invalid response from Telegram' }; }
}

async function sendMessage(token, chatId, text) {
  return tg(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' });
}

// Detect the chat id: user messages their bot, we read getUpdates and grab the
// most recent chat. Returns { id, name } or null.
async function detectChatId(token) {
  const res = await tg(token, 'getUpdates', null);
  if (!res.ok || !Array.isArray(res.result) || res.result.length === 0) return null;
  // Walk from newest, find a message/my_chat_member with a chat.
  for (let i = res.result.length - 1; i >= 0; i--) {
    const u = res.result[i];
    const chat = u.message?.chat || u.my_chat_member?.chat || u.edited_message?.chat;
    if (chat && chat.id != null) {
      const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || String(chat.id);
      return { id: String(chat.id), name };
    }
  }
  return null;
}

// ---- View render ----------------------------------------------------------

export function mountAlerts(root) {
  mounted = true;
  const cfg = getAlertConfig();
  root.innerHTML = renderShell(cfg);
  wireUp(root, cfg);
}

export function unmountAlerts() {
  mounted = false;
}

function renderShell(cfg) {
  const connected = !!(cfg.telegram?.token && cfg.telegram?.chatId);
  return `
    <div class="pt-alerts">
      ${styleBlock()}

      <div class="al-head">
        <div>
          <h2 class="al-title">Alerts</h2>
          <p class="al-sub">Telegram notifications while PoolTerminal runs. No block-producer install.</p>
        </div>
        <div class="al-conn-pill ${connected ? 'on' : ''}" id="al-conn-pill">
          <span class="al-dot"></span>${connected ? 'Connected' : 'Not connected'}
        </div>
      </div>

      <div class="al-cols">
        <div class="al-col-left">
          <div class="al-card al-wizard ${connected ? 'collapsed' : ''}" id="al-wizard">
            <div class="al-card-head">
              <span class="al-card-title">Telegram setup</span>
              ${connected ? '<button class="al-btn al-btn-ghost" id="al-reconfig">Reconfigure</button>' : ''}
            </div>
            <div class="al-wiz-body" id="al-wiz-body" ${connected ? 'style="display:none"' : ''}>
              <div class="al-step" data-step="1">
                <div class="al-step-num">1</div>
                <div class="al-step-body">
                  <div class="al-step-title">Create a bot</div>
                  <div class="al-step-text">In Telegram, message <b>@BotFather</b>, send <code class="al-copy" data-copy="/newbot">/newbot</code>, name it, and paste the token here:</div>
                  <div class="al-inrow">
                    <input type="password" class="al-input" id="al-token" placeholder="Bot token" value="${escapeAttr(cfg.telegram?.token || '')}" autocomplete="off" spellcheck="false">
                    <button class="al-btn al-btn-eye" id="al-token-eye" title="Show/hide">show</button>
                  </div>
                  <div class="al-step-note" title="The token is saved unencrypted in PoolTerminal's local database so alerts keep working after a restart. It controls only the bot you just created - it cannot reach your node, your keys or your funds.">Stored unencrypted on this machine so alerts survive a restart. It controls only this bot &mdash; never your node or keys.</div>
                </div>
              </div>
              <div class="al-step" data-step="2">
                <div class="al-step-num">2</div>
                <div class="al-step-body">
                  <div class="al-step-title">Connect</div>
                  <div class="al-step-text">Open your bot, tap <b>Start</b>, then:</div>
                  <div class="al-inrow">
                    <button class="al-btn al-btn-primary" id="al-detect">Detect chat ID</button>
                    <input type="text" class="al-input" id="al-chatid" placeholder="Chat ID" value="${escapeAttr(cfg.telegram?.chatId || '')}" spellcheck="false">
                  </div>
                  <div class="al-hint" id="al-detect-hint"></div>
                </div>
              </div>
              <div class="al-step" data-step="3">
                <div class="al-step-num">3</div>
                <div class="al-step-body">
                  <div class="al-step-title">Test</div>
                  <div class="al-inrow">
                    <button class="al-btn al-btn-primary" id="al-test">Send test message</button>
                    <span class="al-test-result" id="al-test-result"></span>
                  </div>
                </div>
              </div>
              <div class="al-wiz-foot">
                <button class="al-btn al-btn-save" id="al-save-conn" disabled>Save connection</button>
              </div>
            </div>
          </div>

          <div class="al-card">
            <div class="al-card-head"><span class="al-card-title">Behaviour</span></div>
            <div class="al-behav">
              <label class="al-behav-row">
                <span>Cooldown between repeats</span>
                <select class="al-select" id="al-cooldown">
                  ${[5,10,15,30,60].map((m)=>`<option value="${m}" ${(cfg.cooldownMin||15)===m?'selected':''}>${m} min</option>`).join('')}
                </select>
              </label>
              <label class="al-behav-row">
                <span>Quiet hours</span>
                <span class="al-quiet">
                  <input type="checkbox" id="al-quiet-on" ${cfg.quietHours?.enabled?'checked':''}>
                  <input type="time" class="al-time" id="al-quiet-from" value="${cfg.quietHours?.from||'23:00'}">
                  <span>-</span>
                  <input type="time" class="al-time" id="al-quiet-to" value="${cfg.quietHours?.to||'07:00'}">
                </span>
              </label>
            </div>
          </div>
        </div>

        <div class="al-col-right">
          <div class="al-card al-card-fill">
            <div class="al-card-head"><span class="al-card-title">Alerts</span>
              <span class="al-card-note">What to be notified about</span></div>
            <div class="al-grid" id="al-grid">
              ${ALERT_DEFS.map((d) => alertCard(d, cfg)).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function alertCard(d, cfg) {
  const on = !!cfg.alerts?.[d.id]?.enabled;
  const sev = d.severity;
  return `
    <div class="al-alert sev-${sev} ${on?'on':''}" data-alert="${d.id}">
      <div class="al-alert-top">
        <span class="al-alert-icon">${d.icon}</span>
        <span class="al-alert-name">${d.name}</span>
        <label class="al-switch">
          <input type="checkbox" class="al-alert-toggle" data-id="${d.id}" ${on?'checked':''}>
          <span class="al-slider"></span>
        </label>
      </div>
      <div class="al-alert-desc">${d.desc}</div>
      ${d.threshold ? thresholdControl(d, cfg) : ''}
      <div class="al-alert-foot">
        <span class="al-sev-tag sev-${sev}">${sev}</span>
        <button class="al-btn al-btn-mini al-alert-test" data-id="${d.id}">Test</button>
      </div>
    </div>`;
}

function thresholdControl(d, cfg) {
  const val = cfg.alerts?.[d.id]?.threshold ?? d.threshold.default;
  if (d.threshold.type === 'days-chips') {
    const sel = cfg.alerts?.[d.id]?.days ?? d.threshold.default;
    return `<div class="al-thr">Warn at:
      ${d.threshold.options.map((o)=>`<span class="al-chip ${sel.includes(o)?'on':''}" data-id="${d.id}" data-day="${o}">${o}d</span>`).join('')}
    </div>`;
  }
  return `<div class="al-thr">
    <span>${d.threshold.label}</span>
    <input type="number" class="al-thr-num" data-id="${d.id}" value="${val}" min="${d.threshold.min||0}" max="${d.threshold.max||9999}">
    <span class="al-thr-unit">${d.threshold.unit||''}</span>
  </div>`;
}

function recentRow(r) {
  const t = new Date(r.ts).toLocaleString();
  return `<div class="al-recent-row"><span class="al-recent-icon">${r.icon||'•'}</span>
    <span class="al-recent-msg">${escapeHtml(r.text)}</span>
    <span class="al-recent-time">${t}</span></div>`;
}

// ---- Wiring ---------------------------------------------------------------

function wireUp(root, cfg) {
  // copy-to-clipboard chips
  root.querySelectorAll('.al-copy').forEach((el) => {
    el.addEventListener('click', () => {
      navigator.clipboard?.writeText(el.dataset.copy || el.textContent);
      const old = el.textContent; el.textContent = 'copied!';
      setTimeout(() => { el.textContent = old; }, 1000);
    });
  });

  // token show/hide
  const tokenEl = root.querySelector('#al-token');
  root.querySelector('#al-token-eye')?.addEventListener('click', () => {
    tokenEl.type = tokenEl.type === 'password' ? 'text' : 'password';
  });

  const chatEl = root.querySelector('#al-chatid');
  const saveConnBtn = root.querySelector('#al-save-conn');
  const testResult = root.querySelector('#al-test-result');

  function refreshSaveState() {
    if (saveConnBtn) saveConnBtn.disabled = !(tokenEl?.value.trim() && chatEl?.value.trim());
  }
  tokenEl?.addEventListener('input', refreshSaveState);
  chatEl?.addEventListener('input', refreshSaveState);
  refreshSaveState();

  // Detect chat ID
  root.querySelector('#al-detect')?.addEventListener('click', async () => {
    const hint = root.querySelector('#al-detect-hint');
    const token = tokenEl.value.trim();
    if (!token) { hint.className = 'al-hint err'; hint.textContent = 'Enter your bot token first (step 1).'; return; }
    hint.className = 'al-hint'; hint.textContent = 'Looking for your message to the bot...';
    try {
      const found = await detectChatId(token);
      if (found) {
        chatEl.value = found.id;
        hint.className = 'al-hint ok';
        hint.innerHTML = `Found chat: <b>${escapeHtml(found.name)}</b>`;
        refreshSaveState();
      } else {
        hint.className = 'al-hint err';
        hint.textContent = 'No message found. Open your bot in Telegram, tap Start, then try again.';
      }
    } catch (e) {
      hint.className = 'al-hint err';
      hint.textContent = 'Could not reach Telegram: ' + (e.message || e);
    }
  });

  // Send test message
  root.querySelector('#al-test')?.addEventListener('click', async () => {
    const token = tokenEl.value.trim(); const chatId = chatEl.value.trim();
    if (!token || !chatId) { testResult.className = 'al-test-result err'; testResult.textContent = 'Need token and chat ID first.'; return; }
    testResult.className = 'al-test-result'; testResult.textContent = 'Sending...';
    try {
      const res = await sendMessage(token, chatId,
        '\u2705 <b>PoolTerminal</b> test alert\nYour Telegram alerts are working.');
      if (res.ok) { testResult.className = 'al-test-result ok'; testResult.textContent = 'Sent! Check your phone.'; }
      else { testResult.className = 'al-test-result err'; testResult.textContent = 'Telegram: ' + (res.description || 'failed'); }
    } catch (e) {
      testResult.className = 'al-test-result err'; testResult.textContent = 'Error: ' + (e.message || e);
    }
  });

  // Save connection
  saveConnBtn?.addEventListener('click', () => {
    cfg.telegram = { token: tokenEl.value.trim(), chatId: chatEl.value.trim() };
    saveAlertConfig(cfg);
    // collapse wizard, flip pill
    root.querySelector('#al-wizard')?.classList.add('collapsed');
    const body = root.querySelector('#al-wiz-body'); if (body) body.style.display = 'none';
    const pill = root.querySelector('#al-conn-pill'); if (pill) { pill.classList.add('on'); pill.innerHTML = '<span class="al-dot"></span>Connected'; }
  });

  // Reconfigure
  root.querySelector('#al-reconfig')?.addEventListener('click', () => {
    const body = root.querySelector('#al-wiz-body'); if (body) body.style.display = '';
    root.querySelector('#al-wizard')?.classList.remove('collapsed');
  });

  // Alert toggles
  root.querySelectorAll('.al-alert-toggle').forEach((t) => {
    t.addEventListener('change', () => {
      const id = t.dataset.id;
      cfg.alerts = cfg.alerts || {};
      cfg.alerts[id] = cfg.alerts[id] || {};
      cfg.alerts[id].enabled = t.checked;
      root.querySelector(`.al-alert[data-alert="${id}"]`)?.classList.toggle('on', t.checked);
      saveAlertConfig(cfg);
    });
  });

  // Threshold day-chips
  root.querySelectorAll('.al-chip').forEach((c) => {
    c.addEventListener('click', () => {
      const id = c.dataset.id; const day = parseInt(c.dataset.day);
      cfg.alerts = cfg.alerts || {}; cfg.alerts[id] = cfg.alerts[id] || {};
      const def = ALERT_DEFS.find((d) => d.id === id);
      let days = cfg.alerts[id].days ?? def.threshold.default.slice();
      if (days.includes(day)) days = days.filter((x) => x !== day); else days.push(day);
      cfg.alerts[id].days = days;
      c.classList.toggle('on');
      saveAlertConfig(cfg);
    });
  });

  // Threshold number inputs
  root.querySelectorAll('.al-thr-num').forEach((n) => {
    n.addEventListener('change', () => {
      const id = n.dataset.id;
      cfg.alerts = cfg.alerts || {}; cfg.alerts[id] = cfg.alerts[id] || {};
      cfg.alerts[id].threshold = parseFloat(n.value);
      saveAlertConfig(cfg);
    });
  });

  // Per-alert test
  root.querySelectorAll('.al-alert-test').forEach((b) => {
    b.addEventListener('click', async () => {
      const id = b.dataset.id; const def = ALERT_DEFS.find((d) => d.id === id);
      const token = cfg.telegram?.token; const chatId = cfg.telegram?.chatId;
      if (!token || !chatId) { b.textContent = 'connect first'; setTimeout(()=>b.textContent='Test',1500); return; }
      b.textContent = '...';
      try {
        const res = await sendMessage(token, chatId, `${def.icon} <b>${def.name}</b> (test)\n${def.sample || def.desc}`);
        b.textContent = res.ok ? 'sent ✓' : 'failed';
      } catch { b.textContent = 'error'; }
      setTimeout(() => { b.textContent = 'Test'; }, 1800);
    });
  });

  // Behaviour
  root.querySelector('#al-cooldown')?.addEventListener('change', (e) => { cfg.cooldownMin = parseInt(e.target.value); saveAlertConfig(cfg); });
  root.querySelector('#al-quiet-on')?.addEventListener('change', (e) => { cfg.quietHours = cfg.quietHours||{}; cfg.quietHours.enabled = e.target.checked; saveAlertConfig(cfg); });
  root.querySelector('#al-quiet-from')?.addEventListener('change', (e) => { cfg.quietHours = cfg.quietHours||{}; cfg.quietHours.from = e.target.value; saveAlertConfig(cfg); });
  root.querySelector('#al-quiet-to')?.addEventListener('change', (e) => { cfg.quietHours = cfg.quietHours||{}; cfg.quietHours.to = e.target.value; saveAlertConfig(cfg); });
}

// ---- helpers --------------------------------------------------------------

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function escapeAttr(s) { return escapeHtml(s); }

function styleBlock() {
  return `<style>
  .pt-alerts { padding:14px 20px 20px; max-width:1200px; margin:0 auto; width:100%; color:#cfe0ff; font-family:ui-sans-serif,system-ui,sans-serif; box-sizing:border-box; flex:0 0 auto; }
  .al-cols { display:grid; grid-template-columns:minmax(340px, 420px) 1fr; gap:14px; align-items:start; }
  .al-col-left, .al-col-right { display:flex; flex-direction:column; gap:12px; min-width:0; }
  .al-card-fill { height:100%; }
  .al-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:12px; }
  .al-title { font-size:22px; font-weight:800; color:#e8eefc; margin:0 0 4px; }
  .al-sub { font-size:12.5px; color:#8a97ad; margin:0; max-width:640px; line-height:1.5; }
  .al-conn-pill { display:flex; align-items:center; gap:7px; padding:6px 13px; border-radius:20px; background:#161d2b; border:1px solid #2a3a52; font:700 11px ui-monospace,monospace; color:#8a97ad; white-space:nowrap; }
  .al-conn-pill.on { color:#5dff9b; border-color:#1e5a3a; background:#0f1f18; }
  .al-dot { width:8px; height:8px; border-radius:50%; background:#5a6b8a; }
  .al-conn-pill.on .al-dot { background:#5dff9b; box-shadow:0 0 8px #5dff9b; }

  .al-card { background:#0e1420; border:1px solid #24304a; border-radius:12px; padding:12px 15px; }
  .al-card-head { display:flex; align-items:baseline; justify-content:space-between; margin-bottom:9px; }
  .al-card-title { font:800 14px ui-sans-serif; color:#e8eefc; letter-spacing:.3px; }
  .al-card-note, .al-card-head .al-card-note { font-size:11px; color:#7f8fa8; }

  /* wizard */
  .al-wizard.collapsed { padding-bottom:12px; }
  .al-step { display:flex; gap:11px; padding:10px 0; border-bottom:1px solid #1a2333; }
  .al-step:last-of-type { border-bottom:none; }
  .al-step-num { flex:0 0 28px; width:28px; height:28px; border-radius:50%; background:#1a2740; color:#6fb2ff; display:flex; align-items:center; justify-content:center; font:800 13px ui-monospace,monospace; border:1px solid #2f4a6e; }
  .al-step-body { flex:1; }
  .al-step-title { font:700 13.5px ui-sans-serif; color:#dbe6fb; margin-bottom:5px; }
  .al-step-text { font-size:12px; color:#9db0cc; line-height:1.5; margin-bottom:8px; }
  .al-step-text code { background:#0a1018; padding:2px 7px; border-radius:5px; color:#6fb2ff; font-family:ui-monospace,monospace; font-size:11.5px; border:1px solid #24304a; }
  /* Honest, low-key disclosure at the point the token is entered. Muted so it
     informs without alarming — the blast radius really is just the bot. tg-disclose-v81 */
  .al-step-note { font-size:10.5px; color:#7d8ca6; line-height:1.45; margin-top:6px; cursor:help; }
  .al-copy { cursor:pointer; }
  .al-copy:hover { color:#8fd0ff; border-color:#3a5a80; }

  .al-inrow { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .al-input { flex:1; min-width:180px; background:#0a1018; border:1px solid #2a3a52; border-radius:8px; padding:9px 12px; color:#e8eefc; font:13px ui-monospace,monospace; }
  .al-input:focus { outline:none; border-color:#3a6ea5; box-shadow:0 0 0 2px rgba(58,110,165,.2); }
  .al-btn { cursor:pointer; border:none; border-radius:8px; padding:9px 15px; font:700 12.5px ui-sans-serif; transition:all .15s; }
  .al-btn-primary { background:#1c3a5e; color:#8fd0ff; border:1px solid #2f5a8a; }
  .al-btn-primary:hover { background:#244a76; }
  .al-btn-save { background:#1e5a3a; color:#5dff9b; border:1px solid #2a7a4f; width:100%; margin-top:6px; }
  .al-btn-save:hover:not(:disabled) { background:#276e49; }
  .al-btn-save:disabled { opacity:.4; cursor:not-allowed; }
  .al-btn-ghost { background:transparent; color:#8a97ad; border:1px solid #2a3a52; padding:5px 12px; }
  .al-btn-ghost:hover { color:#cfe0ff; border-color:#3a4a62; }
  .al-btn-eye { background:#161d2b; border:1px solid #2a3a52; padding:9px 11px; }
  .al-btn-mini { padding:4px 11px; font-size:11px; background:#161d2b; color:#8a97ad; border:1px solid #2a3a52; }
  .al-btn-mini:hover { color:#cfe0ff; }
  .al-hint { font-size:11.5px; margin-top:8px; min-height:16px; color:#8a97ad; }
  .al-hint.ok { color:#5dff9b; } .al-hint.err { color:#ff7a6b; }
  .al-test-result { font:700 12px ui-monospace,monospace; }
  .al-test-result.ok { color:#5dff9b; } .al-test-result.err { color:#ff7a6b; }
  .al-wiz-foot { margin-top:12px; }

  /* alert grid */
  .al-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .al-alert { background:#0a0f1a; border:1px solid #1f2b40; border-radius:10px; padding:11px 12px; transition:all .18s; position:relative; overflow:hidden; }
  .al-alert::before { content:''; position:absolute; left:0; top:0; bottom:0; width:3px; background:#2a3a52; transition:background .18s; }
  .al-alert.on.sev-critical::before { background:#ff5a3c; box-shadow:0 0 10px #ff5a3c; }
  .al-alert.on.sev-important::before { background:#ffc24a; box-shadow:0 0 10px #ffc24a; }
  .al-alert.on.sev-info::before { background:#2dd4ee; box-shadow:0 0 10px #2dd4ee; }
  .al-alert.on { border-color:#2f4a6e; background:#0c1320; }
  .al-alert-top { display:flex; align-items:center; gap:9px; margin-bottom:7px; }
  .al-alert-icon { font-size:17px; }
  .al-alert-name { flex:1; font:700 13px ui-sans-serif; color:#dbe6fb; }
  .al-alert-desc { font-size:11px; color:#8a97ad; line-height:1.45; margin-bottom:8px; }
  .al-alert-foot { display:flex; justify-content:space-between; align-items:center; }
  .al-sev-tag { font:700 8.5px ui-monospace,monospace; letter-spacing:.8px; text-transform:uppercase; padding:2px 7px; border-radius:5px; }
  .al-sev-tag.sev-critical { color:#ff5a3c; background:rgba(255,90,60,.12); }
  .al-sev-tag.sev-important { color:#ffc24a; background:rgba(255,194,74,.12); }
  .al-sev-tag.sev-info { color:#2dd4ee; background:rgba(45,212,238,.12); }

  /* switch */
  .al-switch { position:relative; width:38px; height:21px; flex:0 0 auto; }
  .al-switch input { opacity:0; width:0; height:0; }
  .al-slider { position:absolute; inset:0; background:#2a3a52; border-radius:21px; transition:.2s; cursor:pointer; }
  .al-slider::before { content:''; position:absolute; height:15px; width:15px; left:3px; bottom:3px; background:#8a97ad; border-radius:50%; transition:.2s; }
  .al-switch input:checked + .al-slider { background:#1e5a3a; }
  .al-switch input:checked + .al-slider::before { transform:translateX(17px); background:#5dff9b; }

  .al-thr { display:flex; align-items:center; gap:7px; flex-wrap:wrap; font-size:11px; color:#8a97ad; margin-bottom:10px; }
  .al-chip { cursor:pointer; padding:2px 9px; border-radius:12px; background:#161d2b; border:1px solid #2a3a52; font:600 10.5px ui-monospace,monospace; color:#8a97ad; }
  .al-chip.on { background:#1c3a5e; color:#8fd0ff; border-color:#2f5a8a; }
  .al-thr-num { width:56px; background:#0a1018; border:1px solid #2a3a52; border-radius:6px; padding:3px 7px; color:#e8eefc; font:12px ui-monospace,monospace; }

  .al-behav { display:flex; flex-direction:column; gap:10px; }
  .al-behav-row { display:flex; justify-content:space-between; align-items:center; font-size:12.5px; color:#cfe0ff; }
  .al-select, .al-time { background:#0a1018; border:1px solid #2a3a52; border-radius:7px; padding:6px 10px; color:#e8eefc; font:12px ui-monospace,monospace; }
  .al-quiet { display:flex; align-items:center; gap:8px; }

  .al-recent { display:flex; flex-direction:column; gap:6px; }
  .al-recent-row { display:flex; align-items:center; gap:10px; padding:7px 10px; background:#0a0f1a; border-radius:8px; font-size:12px; }
  .al-recent-icon { flex:0 0 auto; }
  .al-recent-msg { flex:1; color:#cfe0ff; }
  .al-recent-time { color:#6f7d99; font:11px ui-monospace,monospace; white-space:nowrap; }
  .al-empty { color:#6f7d99; font-size:12px; padding:8px; text-align:center; }
  </style>`;
}
