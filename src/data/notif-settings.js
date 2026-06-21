/**
 * PoolTerminal — NOTIFICATIONS settings + poll-cadence advisor.
 *
 * Persists the operator's notification poll interval, stake-change threshold and
 * Koios API tier (localStorage). Also computes a SUGGESTED poll interval from the
 * delegator count, the live-data source and (for Koios) the API tier — so the
 * settings panel, and later the setup wizard, can recommend a safe cadence and
 * warn before a manual override would breach the daily call budget.
 *
 * Cost model (Koios): each poll costs ~1 `pool_delegators` call + one
 * `account_info` page per 50 delegators, plus a small allowance for
 * ticker/leaver lookups. With db-sync there is no API budget at all (it reads
 * the operator's own database).
 */

import { registry, DataKind } from './capabilities.js';

const KEY = 'poolterminal.notif.v1';
const DAY_MS = 86_400_000;

export const DEFAULT_POLL_MS = 5 * 60 * 1000;          // 5 min
export const DEFAULT_THRESHOLD_LOVELACE = 10_000_000;  // 10 ADA
const DEFAULTS = {
  pollMs: DEFAULT_POLL_MS,
  thresholdLovelace: DEFAULT_THRESHOLD_LOVELACE,
  koiosTier: 'free',   // 'free' | 'token'
};

// Cadence ladder offered to the operator (ms).
export const POLL_LADDER_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000, 3_600_000];
// Koios daily call budgets by tier.
export const TIER_BUDGET = { free: 5000, token: 50000 };
// Blockfrost free-tier daily budget (registered project key).
export const BLOCKFROST_BUDGET = 50000;
// Blockfrost calls per poll: notifications only need the paginated delegator
// list (100/page), no per-account calls. +1 small allowance.
export function bfCallsPerPoll(n) { return 1 + Math.ceil((Number(n) || 0) / 100); }
// Leave headroom for other Koios use (pool info, tickers): notifications take
// at most this fraction of the daily budget when computing a suggestion.
const NOTIF_BUDGET_FRACTION = 0.7;

let _s = load();
function load() {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY)) || {}) }; }
  catch { return { ...DEFAULTS }; }
}

export function getNotifSettings() { return { ..._s }; }
export function getNotifPollMs() { return _s.pollMs > 0 ? _s.pollMs : DEFAULT_POLL_MS; }
export function getNotifThresholdLovelace() {
  return (_s.thresholdLovelace != null && _s.thresholdLovelace >= 0)
    ? _s.thresholdLovelace : DEFAULT_THRESHOLD_LOVELACE;
}
export function getKoiosTier() { return _s.koiosTier === 'token' ? 'token' : 'free'; }

export function saveNotifSettings(partial) {
  _s = { ..._s, ...partial };
  try { localStorage.setItem(KEY, JSON.stringify(_s)); }
  catch (e) { console.warn('[notif-settings] save failed:', e.message ?? e); }
  return { ..._s };
}

/** Which source answers the live delegator set: 'dbsync' | 'koios' | 'blockfrost' | null. */
export function getNotifSource() {
  let id = null;
  try { const d = registry.describe(DataKind.DELEGATOR_LIST_LIVE); id = d && d.id; } catch { id = null; }
  if (!id) return null;
  if (id.startsWith('dbsync')) return 'dbsync';
  if (id.startsWith('blockfrost')) return 'blockfrost';
  if (id.startsWith('koios')) return 'koios';
  return id;
}

/** Approx Koios calls consumed per poll for N delegators. */
export function callsPerPoll(n) { return 2 + Math.ceil((Number(n) || 0) / 50); }

/** Human interval label from ms. */
export function fmtInterval(ms) {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/**
 * Suggest a safe poll interval.
 * @returns {{ms:number, reason:string, unlimited:boolean, callsPerPoll:number, over:boolean}}
 */
export function suggestPollMs({ delegatorCount = 0, source = 'koios', koiosTier = 'free' } = {}) {
  if (source === 'dbsync') {
    return {
      ms: 120_000,
      reason: 'db-sync reads your own database — no API limits. Defaulting to every 2 minutes; you can poll faster.',
      unlimited: true, callsPerPoll: 0, over: false,
    };
  }
  if (source === 'blockfrost') {
    const bcpp = bfCallsPerPoll(delegatorCount);
    const bbudget = BLOCKFROST_BUDGET * NOTIF_BUDGET_FRACTION;
    const bmaxPolls = Math.max(1, Math.floor(bbudget / bcpp));
    const bminMs = Math.ceil(DAY_MS / bmaxPolls);
    let bms = POLL_LADDER_MS.find((v) => v >= bminMs);
    let bover = false;
    if (!bms) { bms = POLL_LADDER_MS[POLL_LADDER_MS.length - 1]; bover = true; }
    const breason = bover
      ? `${delegatorCount} delegators need ~${bcpp} Blockfrost calls per poll — too many to stay safe even hourly on the 50k/day free tier. Consider db-sync for live updates, or a higher Blockfrost plan.`
      : `${delegatorCount} delegators is about ${bcpp} Blockfrost call(s) per poll. ${fmtInterval(bms)} keeps notifications within ~${Math.round(NOTIF_BUDGET_FRACTION * 100)}% of the ${BLOCKFROST_BUDGET.toLocaleString()}/day Blockfrost budget.`;
    return { ms: bms, reason: breason, unlimited: false, callsPerPoll: bcpp, over: bover };
  }
  const cpp = callsPerPoll(delegatorCount);
  const tier = TIER_BUDGET[koiosTier] ? koiosTier : 'free';
  const budget = TIER_BUDGET[tier] * NOTIF_BUDGET_FRACTION;
  const maxPolls = Math.max(1, Math.floor(budget / cpp));
  const minMs = Math.ceil(DAY_MS / maxPolls);
  let ms = POLL_LADDER_MS.find((v) => v >= minMs);
  let over = false;
  if (!ms) { ms = POLL_LADDER_MS[POLL_LADDER_MS.length - 1]; over = true; }
  const reason = over
    ? `${delegatorCount} delegators on the Koios ${tier} tier need ~${cpp} calls per poll — too many to stay safe even hourly. Use a registered Koios token (50k/day) or db-sync for live updates.`
    : `${delegatorCount} delegators is about ${cpp} Koios calls per poll. ${fmtInterval(ms)} keeps notifications within ~${Math.round(NOTIF_BUDGET_FRACTION * 100)}% of the ${TIER_BUDGET[tier].toLocaleString()}/day ${tier}-tier budget.`;
  return { ms, reason, unlimited: false, callsPerPoll: cpp, over };
}

/**
 * Estimate daily Koios usage for a chosen interval; flags a budget breach.
 * @returns {{callsPerDay:number, budget:number, breaches:boolean}}
 */
export function pollUsage({ ms, delegatorCount = 0, source = 'koios', koiosTier = 'free' }) {
  if (source === 'dbsync') return { callsPerDay: 0, budget: Infinity, breaches: false };
  if (source === 'blockfrost') {
    const bcpp = bfCallsPerPoll(delegatorCount);
    const bpolls = DAY_MS / Math.max(1000, ms);
    const bcalls = Math.round(bcpp * bpolls);
    return { callsPerDay: bcalls, budget: BLOCKFROST_BUDGET, breaches: bcalls > BLOCKFROST_BUDGET };
  }
  const cpp = callsPerPoll(delegatorCount);
  const pollsPerDay = DAY_MS / Math.max(1000, ms);
  const callsPerDay = Math.round(cpp * pollsPerDay);
  const tier = TIER_BUDGET[koiosTier] ? koiosTier : 'free';
  return { callsPerDay, budget: TIER_BUDGET[tier], breaches: callsPerDay > TIER_BUDGET[tier] };
}
