/**
 * PoolTerminal — Koios HISTORY source (bulk, rate-limit-safe).
 *
 * The portable HISTORY source for operators WITHOUT db-sync. Mirrors the
 * db-sync source's contract exactly — same canonical EpochRow shape, same
 * `source` interface, registered behind the same selector — so HISTORY doesn't
 * care which one is active.
 *
 * RATE-LIMIT DESIGN (this is the whole point):
 *   The entire backfill is ONE call to /pool_history, which returns every epoch
 *   the pool has existed for in a single response (validated: 408 rows in one
 *   call). No per-epoch loops — that loop is what got us banned before.
 *
 *   Net active stake (for ideal-block calc) is derived LOCALLY from the
 *   per-epoch `active_stake_pct` Koios already returns:
 *       net_stake = active_stake / (active_stake_pct / 100)
 *   so we need no per-epoch /epoch_info calls either. Worst case: 1 request.
 *
 * Field mapping (pool_history → EpochRow):
 *   block_cnt      → adopted / confirmed   (on-chain finalised blocks)
 *   delegator_cnt  → delegators
 *   active_stake   → activeStake (ADA) / activeStakeLovelace
 *   member_rewards → memberRewards         (delegators' share)
 *   pool_fees      → leaderReward          (operator take = fixed_cost + margin)
 *   margin         → margin
 *   fixed_cost     → fixedCost (ADA)
 *   epoch_ros      → ros
 *   saturation_pct → saturation
 *   ideal          → derived: netBlocks * (active_stake / net_stake), see below
 */

import { invoke } from './tauri.js';
import { DataKind, registry } from './capabilities.js';

const KOIOS_BASE = 'https://api.koios.rest/api/v1';
const CURL_MAX_TIME = 12;

// The per-epoch kinds Koios pool_history can answer (same set as db-sync).
const PROVIDES = [
  DataKind.EPOCH_BLOCKS,
  DataKind.EPOCH_IDEAL,
  DataKind.EPOCH_STAKE,
  DataKind.EPOCH_DELEGATORS,
  DataKind.EPOCH_REWARDS,
  DataKind.POOL_PARAMS,
];

let _bech32 = null;
let _ready = false;

async function runCmd(command) {
  const r = await invoke('ssh_run', { command });
  if (typeof r === 'string') return r;
  return r?.stdout ?? '';
}
function parseJson(out, fallback) {
  if (!out || !out.trim()) return fallback;
  try { return JSON.parse(out); } catch (e) { console.warn('[koios-hist] parse:', e.message); return fallback; }
}
function lovelaceToAda(l) { return l == null ? null : Number(l) / 1_000_000; }
function numOrNull(v) { return v == null ? null : Number(v); }

/**
 * ONE call: full per-epoch pool history. Returns the raw Koios array (desc),
 * or [] on failure. This is the only network request the source makes.
 */
async function fetchPoolHistory() {
  const url = `${KOIOS_BASE}/pool_history?_pool_bech32=${_bech32}&order=epoch_no.desc`;
  const out = await runCmd(`curl -sf --max-time ${CURL_MAX_TIME} '${url}'`);
  const arr = parseJson(out, null);
  if (!Array.isArray(arr)) {
    console.warn('[koios-hist] pool_history returned no array');
    return [];
  }
  return arr;
}

/** Map one Koios pool_history row → canonical EpochRow (db-sync-compatible). */
function toEpochRow(h) {
  const epoch = Number(h.epoch_no);
  const activeStakeLovelace = h.active_stake != null ? Number(h.active_stake) : null;
  const blocks = h.block_cnt != null ? Number(h.block_cnt) : null;

  // Net stake derived locally from our pct share — no extra API call.
  // active_stake_pct is a PERCENTAGE (validated: 0.00472 = 0.00472% of network,
  // i.e. your_stake/net_stake = pct/100), NOT a bare fraction.
  let ideal = null;
  const pct = h.active_stake_pct != null ? Number(h.active_stake_pct) : null;
  // Ideal blocks ≈ epoch block slots * your stake fraction. Mainnet epoch has
  // ~21600 expected block slots (432000 slots * 0.05 active-slot coefficient).
  const EPOCH_IDEAL_BLOCKS = 21600;
  if (pct != null && pct > 0) ideal = +(EPOCH_IDEAL_BLOCKS * (pct / 100)).toFixed(2);

  // Rewards: member = delegators' share; pool_fees = operator take.
  const member = h.member_rewards != null ? lovelaceToAda(h.member_rewards) : null;
  const leader = h.pool_fees != null ? lovelaceToAda(h.pool_fees) : null;

  // Reward state: Koios pool_history only has finalised epochs, so if the row
  // exists rewards are complete; block_cnt 0 with 0 rewards is a genuine zero.
  let rewardsState = 'complete';
  if (blocks === 0 && (h.member_rewards === '0' || h.member_rewards == null)) rewardsState = 'zero';

  return {
    epoch,
    adopted: blocks, confirmed: blocks, leader: null, lost: null,
    delegators: h.delegator_cnt != null ? Number(h.delegator_cnt) : null,
    activeStake: lovelaceToAda(activeStakeLovelace),
    activeStakeLovelace,
    memberRewards: member,
    leaderReward: leader,
    delegRewards: h.deleg_rewards != null ? lovelaceToAda(h.deleg_rewards) : null,
    margin: numOrNull(h.margin),
    fixedCost: lovelaceToAda(h.fixed_cost),
    ideal,
    saturation: h.saturation_pct != null ? Number(h.saturation_pct) : null,
    ros: h.epoch_ros != null ? Number(h.epoch_ros) : null,
    rewardsState,
    source: 'koios',
  };
}

/**
 * fetchHistory(from, to) — same signature as db-sync. One pool_history call,
 * filtered to the requested epoch range, mapped to canonical rows ascending.
 */
export async function fetchHistory(from, to) {
  const hist = await fetchPoolHistory();
  const rows = hist
    .map(toEpochRow)
    .filter((r) => Number.isInteger(r.epoch) && (from == null || r.epoch >= from) && (to == null || r.epoch <= to))
    .sort((a, b) => a.epoch - b.epoch);
  return rows;
}

/** First epoch the pool has history for (min epoch in one call). */
export async function getPoolFirstEpoch() {
  const hist = await fetchPoolHistory();
  if (!hist.length) return null;
  return Math.min(...hist.map((h) => Number(h.epoch_no)).filter(Number.isInteger));
}

export const koiosSource = {
  id: 'koios',
  label: 'Koios',
  isCli: false,
  provides: () => (_ready ? PROVIDES : []),
  reachable: () => _ready,
  version: () => 'api.koios.rest',
  get: async (kind, params = {}) => {
    switch (kind) {
      case DataKind.EPOCH_BLOCKS:
      case DataKind.EPOCH_IDEAL:
      case DataKind.EPOCH_STAKE:
      case DataKind.EPOCH_DELEGATORS:
      case DataKind.EPOCH_REWARDS:
      case DataKind.POOL_PARAMS:
        return fetchHistory(params.from, params.to);
      default:
        throw new Error(`koios source can't provide ${kind}`);
    }
  },
  // Koios is a hosted API, no schema drift to track.
  schemaTested: null,
  schemaCurrent: () => 'api.koios.rest',
  schemaStale: () => false,
};

/**
 * Resolve the pool bech32, probe Koios liveness (one tiny /tip call), and
 * register into the capability spine. Returns true if reachable.
 * Called by the read-model/main when the user has selected Koios for history.
 */
export async function initKoios(poolBech32) {
  _bech32 = poolBech32;
  _ready = false;
  try {
    const out = await runCmd(`curl -sf --max-time 6 '${KOIOS_BASE}/tip'`);
    const tip = parseJson(out, null);
    _ready = Array.isArray(tip) && tip.length > 0;
    if (!_ready) { console.warn('[koios-hist] not reachable at init'); return false; }
    if (!registry.all().some((s) => s.id === 'koios')) registry.register(koiosSource);
    console.log('[koios-hist] ready — tip epoch', tip[0]?.epoch_no);
    return true;
  } catch (err) {
    console.warn('[koios-hist] init failed:', err.message ?? err);
    return false;
  }
}

export function resetKoios() { _bech32 = null; _ready = false; }
