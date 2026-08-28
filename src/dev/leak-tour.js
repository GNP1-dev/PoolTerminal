/*leak-tour-v104*/
/**
 * PoolTerminal — demo-isolation leak tour (dev harness).
 *
 * Proves, on every release, that DEMO mode shows no real values even after a
 * LIVE session has populated every cache — the leak class no runtime gate can
 * enforce (view-local caches, config echoed into UI, dev-time literals). See
 * RELEASING.md: run this before any build.
 *
 * WHAT IT DOES
 *  Phase 1 (LIVE-SIM): registers a fake live source (id 'dbsync', so the
 *    registry's mode gate treats it as live) serving SENTINEL values, sets the
 *    own-pool ticker to a sentinel, switches to live mode and mounts the
 *    data-heavy views — poisoning the module caches exactly like a real
 *    session does.
 *  Phase 2 (DEMO): flips to demo INSIDE every cache TTL, walks every tab, and
 *    after each one scans the entire DOM for (a) the sentinels and (b) any
 *    extra terms you provide — your real host, ticker, unit names, addresses.
 *    It also records every Tauri command invoked after the flip and flags any
 *    that could touch a node, Postgres, an API, or the pool-data cache.
 *
 * HOW TO RUN (dev build or packaged app, no code changes):
 *  1. Open the webview devtools console and arm it:
 *       localStorage.setItem('poolterminal.dev.leaktour', '1')
 *     Optionally add your own real values to scan for (STRONGLY recommended —
 *     this is what catches config echoes and baked literals):
 *       localStorage.setItem('poolterminal.dev.leaktour.terms',
 *         JSON.stringify(['192.168.0.62', 'GNP1', 'cnode_bp', 'your-host']))
 *  2. Restart / reload the app. The tour runs once (~2.5 min), disarms itself,
 *     and renders a per-tab PASS/FAIL report full-screen. The report is also
 *     saved to localStorage 'poolterminal.dev.leaktour.report'.
 *
 * WHAT NOT TO PUT IN TERMS (and what the allowlist does)
 *  Strings that legitimately appear in the app in every mode — the tickertape
 *  brand link, the app identifier, the agreed demo metadata-feed messages —
 *  would flag on every tab and drown real findings. Those EXACT strings are
 *  listed in ALLOWLIST below and are stripped from the DOM text before terms
 *  are matched, so a term like 'GNP1' stays useful: the agreed brand
 *  occurrences are invisible to it, while a GNP1 that shows up anywhere else
 *  (a notification pill, a hero label, a stale ticker) still FAILs the tour.
 *  Keep the allowlist to exact, agreed strings — never add a bare term like
 *  'GNP1' itself, which would blind the tour to the leak class it exists for.
 *
 * LIVE-COLLECTOR TAIL
 *  On a live-connected install, background collectors (history backfill,
 *  ideal fill) may be mid-flight when the tour flips to demo. They now
 *  quiesce on the mode flip (collector-quiesce-v105), but their last
 *  in-flight call can still land just after it — so the tour waits a short
 *  grace period after flipping before it starts counting, and reports how
 *  many calls fell inside that window as "excluded (live-collector tail)".
 *
 * The tour never touches persisted config and never runs unless armed; in an
 * unarmed app this module is never even imported.
 */

// Exact agreed-legitimate strings, stripped from the DOM text before term
// matching (see the header). These are the ONLY places brand strings may
// appear in demo; anywhere else still fails. /*leak-tour-allowlist-v105*/
const ALLOWLIST = [
  'developed by GrahamsNumberPlus1',
  'grahamsnumberplus1.com',
  'com.gnp1.poolterminal',
  'GNP1 Zero-Fee Pool',            // agreed demo metadata-feed messages
  '/gnp1/i.test',                  // own-message highlight predicate, if ever inlined
];

const SENT_STAKE = 'stake1uleakleakleakleakleakleakleakleakleakleakleakleak';
const SENT_NUMS = ['99,999,999', '88,888,888', '77,777,777'];
const SENT_TICKER = 'LEAKT';
const FLAGGED_CMDS = /ssh_run|local_run|pg_query|koios_http|telegram_send|relay_ssh_run|cache_get|cache_loyalty|cache_clear/;
const TABS = ['now2', 'history', 'delegators', 'notifications', 'node-health', 'logs', 'alerts', 'data', 'map', 'relay1', 'relay2', 'about'];

const fakeLiveSource = {
  id: 'dbsync', label: 'db-sync (LEAKTOUR)', isCli: false,
  provides: () => ['DELEGATOR_LIST', 'POOL_LIVE', 'DELEGATOR_LOYALTY', 'EPOCH_BLOCKS', 'EPOCH_REWARDS'],
  reachable: () => true, version: () => 'leaktour',
  async get(kind) {
    if (kind === 'POOL_LIVE') return { liveStake: 99999999, activeStake: 88888888, liveDelegators: 3, livePledge: 77777777, declaredPledge: 77777000, liveSaturation: 0.42 };
    if (kind === 'DELEGATOR_LIST') return [1, 2, 3].map((n) => ({ stake: SENT_STAKE + n, liveStake: n * 11111111, liveStakeLovelace: n * 11111111 * 1e6, isOwner: false, stakeBasis: 'snapshot', basisEpoch: 999 }));
    if (kind === 'DELEGATOR_LOYALTY') return [];
    if (kind === 'EPOCH_BLOCKS' || kind === 'EPOCH_REWARDS') return [{ epoch: 999, adopted: 77, ideal: 77.7, activeStake: 88888888, delegators: 3, memberRewards: 777777, leaderReward: 777, margin: 0, fixedCost: 170, source: 'leaktour' }];
    throw new Error('leaktour cannot ' + kind);
  },
};

function chip(txt, col) {
  let c = document.getElementById('pt-leaktour-chip');
  if (!c) {
    c = document.createElement('div');
    c.id = 'pt-leaktour-chip';
    c.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99998;font:11px monospace;background:#111;padding:3px 8px;border-radius:4px;max-width:1300px;';
    document.body.appendChild(c);
  }
  c.textContent = txt; c.style.color = col || '#5dff9b';
}

function scanDom(terms) {
  let html = document.body.innerHTML;
  for (const a of ALLOWLIST) html = html.split(a).join('');   /*leak-tour-allowlist-v105*/
  return terms.filter((t) => t && html.includes(t));
}

function report(results, invokesAfter, badCmds, excludedTail = 0) {
  const fails = results.filter((r) => r.hits.length);
  const lines = results.map((r) =>
    `${r.hits.length ? 'FAIL' : ' ok '}  ${r.tab.padEnd(14)}${r.hits.length ? '  found: ' + r.hits.join(', ') : ''}`).join('\n');
  const verdict = (fails.length === 0 && badCmds.length === 0) ? 'PASS - demo showed no real or sentinel values' : 'FAIL - see below';
  const text = `DEMO-ISOLATION LEAK TOUR - ${verdict}\n\n`
    + `demo-phase invoke calls: ${invokesAfter}   flagged: ${badCmds.length}${badCmds.length ? ' [' + badCmds.join(', ') + ']' : ''}\n`
    + `excluded (live-collector tail, inside the post-flip grace window): ${excludedTail}\n\n`
    + lines
    + '\n\n(disarmed - re-arm via localStorage to run again; report saved to poolterminal.dev.leaktour.report)';
  try { localStorage.setItem('poolterminal.dev.leaktour.report', JSON.stringify({ at: new Date().toISOString(), verdict, results, invokesAfter, badCmds, excludedTail })); } catch { /* ignore */ }
  const pre = document.createElement('pre');
  pre.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#0d1117;color:' + (fails.length || badCmds.length ? '#ff5a5a' : '#5dff9b') + ';font:13px monospace;padding:24px;overflow:auto;white-space:pre-wrap;';
  pre.textContent = text;
  pre.title = 'Click to dismiss';
  pre.addEventListener('click', () => pre.remove());
  document.body.appendChild(pre);
  console.log('[leak-tour]', verdict, { results, invokesAfter, badCmds });
}

/**
 * Entry point. `ctx` is supplied by main.js and carries the app internals the
 * tour drives: { registry, setMode, getMode, mountView, paintMode,
 * startPolling, setOwnPoolTicker }.
 */
export function runLeakTour(ctx) {
  try { localStorage.removeItem('poolterminal.dev.leaktour'); } catch { /* ignore */ }
  let extra = [];
  try { extra = JSON.parse(localStorage.getItem('poolterminal.dev.leaktour.terms') || '[]'); } catch { extra = []; }
  const TERMS = ['leakleak', SENT_TICKER, ...SENT_NUMS, ...extra];
  const LOG = window.__ptInvokeLog = [];   // recorded by the invoke shim's audit hook

  ctx.registry.register(fakeLiveSource);

  const STEP_MS = 9000;
  setTimeout(() => {
    document.getElementById('cn-modal')?.remove();
    document.getElementById('wz-modal')?.remove();
    ctx.setMode('live');
    ctx.paintMode();
    ctx.setOwnPoolTicker(SENT_TICKER);
    chip('LEAK TOUR phase 1: LIVE-SIM - poisoning caches (delegators, dashboard)');
    ctx.mountView('delegators');
    setTimeout(() => ctx.mountView('now2'), 6000);

    setTimeout(() => {
      LOG.push('--- MODE -> demo ---');
      ctx.setMode('demo');
      window.dispatchEvent(new Event('pt:mode-changed'));
      chip('LEAK TOUR: mode flipped - grace window for the live-collector tail');
      const results = [];
      let i = 0;
      const step = () => {
        document.getElementById('cn-modal')?.remove();
        if (i > 0) results.push({ tab: TABS[i - 1], hits: scanDom(TERMS) });   // scan the tab that just had its dwell
        if (i < TABS.length) {
          try { ctx.mountView(TABS[i]); } catch (e) { LOG.push('MOUNT-FAIL:' + TABS[i]); }
          chip(`LEAK TOUR phase 2: DEMO ${i + 1}/${TABS.length} ${TABS[i]}`);
          i++;
          setTimeout(step, STEP_MS);
        } else {
          // Count from the QUIESCED marker: collectors abort on the mode flip
          // (collector-quiesce-v105), but a call already in flight can land
          // inside the grace window - those are the live session's tail, not
          // demo activity, and are reported as excluded. /*leak-tour-grace-v105*/
          const flip = LOG.indexOf('--- MODE -> demo ---');
          const cut = LOG.indexOf('--- DEMO QUIESCED ---');
          const excluded = LOG.slice(flip + 1, cut).filter((c) => !c.startsWith('MOUNT-FAIL')).length;
          const after = LOG.slice(cut + 1).filter((c) => !c.startsWith('MOUNT-FAIL'));
          const bad = after.filter((c) => FLAGGED_CMDS.test(c));
          report(results, after.length, bad, excluded);
        }
      };
      // Grace: let in-flight collector calls drain before counting begins.
      setTimeout(() => { LOG.push('--- DEMO QUIESCED ---'); step(); }, 6000);
    }, 14000);
  }, 3000);
}
