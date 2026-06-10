/**
 * PoolTerminal — Blockfrost access layer (OPTIONAL enrichment source).
 *
 * Blockfrost (https://blockfrost.io) is an OPT-IN add-on, not a requirement.
 * The app works for everyone on db-sync or Koios alone; if the operator has (or
 * gets) a Blockfrost project key, the setup wizard enables this source and the
 * DELEGATORS view gains deep per-delegator detail, migration history (which
 * pools a delegator moved through), pool lifecycle, and DRep status.
 *
 * Because it is optional, this source REGISTERS ONLY IF A KEY IS PRESENT. With
 * no key it simply isn't in the registry, so every view falls back to db-sync /
 * Koios automatically — never broken, just lighter. (See MANUAL §4 product
 * principle.)
 *
 * Transport: same seam as koios-query.js — `curl` ON THE NODE over SSH (the node
 * has egress; the WebView hits CORS). Only the project_id header differs. A
 * future wizard transport option (MANUAL §4.7) swaps runCmd() alone.
 *
 * Defensive: any SSH/curl/parse failure logs and returns null/[] rather than
 * throwing, so a Blockfrost hiccup degrades gracefully.
 *
 * Rate: free tier is 50k/day, 10/sec. Our use is targeted — cheap list view,
 * and ~2 calls only when the operator clicks INTO a specific delegator.
 */

import { invoke } from './tauri.js';
import { DataKind, registry } from './capabilities.js';

const BF_BASE = 'https://cardano-mainnet.blockfrost.io/api/v0';
const CURL_MAX_TIME = 8;

let _key = null;       // project_id; null = not configured = source not registered
let _poolBech32 = null;
let _reachable = false;

// Persisted key (temporary, pre-wizard). The wizard will later capture this via
// a friendly flow and ideally the OS keychain.
const KEY_STORE = 'pt.blockfrost_key';

function loadKey() {
  try { return localStorage.getItem(KEY_STORE) || null; } catch { return null; }
}
export function setBlockfrostKey(key) {
  _key = key || null;
  try {
    if (key) localStorage.setItem(KEY_STORE, key);
    else localStorage.removeItem(KEY_STORE);
  } catch { /* ignore */ }
}
export function hasBlockfrostKey() { return !!(_key || loadKey()); }

async function runCmd(command) {
  const r = await invoke('ssh_run', { command });
  if (typeof r === 'string') return r;
  return r?.stdout ?? '';
}
function parseJson(out, fallback) {
  if (!out || !out.trim()) return fallback;
  try { return JSON.parse(out); } catch (e) { console.warn('[blockfrost] parse:', e.message); return fallback; }
}
function lovelaceToAda(l) { return l == null ? null : Number(l) / 1_000_000; }

/** GET a Blockfrost path with the project_id header; returns parsed JSON or fallback. */
async function bfGet(path, fallback) {
  if (!_key) return fallback;
  const url = `${BF_BASE}${path}`;
  const out = await runCmd(`curl -sf --max-time ${CURL_MAX_TIME} -H 'project_id: ${_key}' '${url}'`);
  return parseJson(out, fallback);
}

// ============================================================
// Endpoints (validated by hand — see MANUAL §4)
// ============================================================

/** POOL_LIVE — rich live summary for the operator's pool (1 call). */
async function getPoolLive() {
  const p = await bfGet(`/pools/${_poolBech32}`, null);
  if (!p) return null;
  return {
    poolId: p.pool_id,
    blocksMinted: p.blocks_minted != null ? Number(p.blocks_minted) : null,
    blocksEpoch: p.blocks_epoch != null ? Number(p.blocks_epoch) : null,
    liveStake: lovelaceToAda(p.live_stake),
    activeStake: lovelaceToAda(p.active_stake),
    liveSaturation: p.live_saturation != null ? Number(p.live_saturation) : null,
    liveDelegators: p.live_delegators != null ? Number(p.live_delegators) : null,
    declaredPledge: lovelaceToAda(p.declared_pledge),
    livePledge: lovelaceToAda(p.live_pledge),
    margin: p.margin_cost != null ? Number(p.margin_cost) : null,
    fixedCost: lovelaceToAda(p.fixed_cost),
    rewardAccount: p.reward_account,
    owners: Array.isArray(p.owners) ? p.owners : [],
    registrations: Array.isArray(p.registration) ? p.registration : [],
  };
}

/** DELEGATOR_LIST — current delegators, paginated. Cheap list view.
 *  Returns [{ stake, liveStake }] sorted by stake desc; owner/pledge flagged. */
async function getDelegatorList() {
  const owners = new Set();
  // Need owners to flag the pledge "delegator" (the reward/owner stake address).
  const live = await getPoolLive();
  if (live) { (live.owners || []).forEach((o) => owners.add(o)); if (live.rewardAccount) owners.add(live.rewardAccount); }

  const out = [];
  for (let page = 1; page <= 20; page++) {     // up to 2000 delegators; stop when a page is short
    const rows = await bfGet(`/pools/${_poolBech32}/delegators?count=100&page=${page}`, []);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const d of rows) {
      out.push({
        stake: d.address,
        liveStake: lovelaceToAda(d.live_stake),
        liveStakeLovelace: d.live_stake != null ? Number(d.live_stake) : null,
        isOwner: owners.has(d.address),
      });
    }
    if (rows.length < 100) break;
  }
  out.sort((a, b) => (b.liveStakeLovelace || 0) - (a.liveStakeLovelace || 0));
  return out;
}

/** DELEGATOR_DETAIL — one delegator deep-dive (~2 calls, ON DEMAND).
 *  Account summary + full pool-movement trail (the migration history). */
// Read cached per-epoch stake for a delegator from poolterminal.db.
// Returns [{ epoch, poolId, amount(lovelace) }] ascending (may be empty).
async function cacheGetDelegatorStake(stake) {
  try {
    const rows = await invoke('cache_get_delegator_stake', { poolId: _poolBech32, stakeAddr: stake });
    return (rows || []).map((r) => ({ epoch: Number(r.epoch), poolId: r.delegPool, amount: Number(r.amount) }));
  } catch (e) { console.warn('[bf] cache_get_delegator_stake:', e.message ?? e); return []; }
}
// Highest epoch already cached for a delegator (or null).
async function cacheDelegatorMaxEpoch(stake) {
  try { return await invoke('cache_delegator_max_epoch', { poolId: _poolBech32, stakeAddr: stake }); }
  catch (e) { console.warn('[bf] cache_delegator_max_epoch:', e.message ?? e); return null; }
}
// Persist new per-epoch rows for a delegator (batched in one tx on the Rust side).
async function cachePutDelegatorStake(stake, rows) {
  if (!rows.length) return;
  try {
    await invoke('cache_put_delegator_stake', {
      poolId: _poolBech32,
      stakeAddr: stake,
      rows: rows.map((r) => ({ epoch: r.epoch, delegPool: r.poolId, amount: r.amount })),
    });
  } catch (e) { console.warn('[bf] cache_put_delegator_stake:', e.message ?? e); }
}

// Fetch a delegator's full per-epoch active-stake history, using the local cache
// as the source of truth for past epochs and fetching from Blockfrost ONLY the
// epochs newer than what's cached. Past epochs are immutable on-chain, so after
// the first populate this makes at most one page of calls (usually zero). The
// CURRENT epoch is always re-fetched (it's still changing) and overwritten.
async function getDelegatorStakeHistory(stake, currentEpoch) {
  const cached = await cacheGetDelegatorStake(stake);
  const maxCached = await cacheDelegatorMaxEpoch(stake);

  // We must (re)fetch if: nothing cached, OR the newest cached epoch is the
  // current (still-mutable) epoch, OR the current epoch is beyond what we have.
  const needFetch = maxCached == null || currentEpoch == null || maxCached <= currentEpoch;
  let merged = cached.slice();

  if (needFetch) {
    // Pull history newest-first and stop once we're at/below the cached max-1
    // (so we capture the current epoch refresh + any gap, without re-pulling all).
    const fetched = [];
    const stopBelow = (maxCached == null) ? -1 : (maxCached - 1);  // re-take current too
    for (let page = 1; page <= 12; page++) {
      const rows = await bfGet(`/accounts/${stake}/history?count=100&page=${page}&order=desc`, []);
      if (!Array.isArray(rows) || rows.length === 0) break;
      let reachedKnown = false;
      for (const h of rows) {
        if (h.active_epoch == null) continue;
        const ep = Number(h.active_epoch);
        if (ep <= stopBelow) { reachedKnown = true; continue; }
        fetched.push({ epoch: ep, poolId: h.pool_id, amount: Number(h.amount) });
      }
      if (reachedKnown || rows.length < 100) break;
    }
    if (fetched.length) {
      await cachePutDelegatorStake(stake, fetched);
      // Merge fetched into cached (fetched wins on epoch collisions e.g. current).
      const byEpoch = new Map(merged.map((r) => [r.epoch, r]));
      for (const r of fetched) byEpoch.set(r.epoch, r);
      merged = [...byEpoch.values()];
    }
  }
  merged.sort((a, b) => a.epoch - b.epoch);
  return merged;
}

async function getDelegatorDetail(stake, currentEpoch) {
  if (!stake) return null;
  const acct = await bfGet(`/accounts/${stake}`, null);

  // Per-epoch active stake + pool, oldest→newest — from cache + only-new fetch.
  // `amount` is the REAL active stake at each epoch (matches db-sync epoch_stake,
  // verified), not a cert transaction value.
  const hist = await getDelegatorStakeHistory(stake, currentEpoch);

  // Group contiguous same-pool epochs into RUNS. Each run = one pool the
  // delegator was in, with entry (first epoch + stake) and exit (last epoch +
  // stake). The final run is their CURRENT pool — marked isCurrent ("still
  // here", no exit). Each run's exit epoch equals the next run's entry epoch,
  // so the chain is self-verifying.
  const runs = [];
  for (const row of hist) {
    const last = runs[runs.length - 1];
    if (last && last.poolId === row.poolId) {
      last.exitEpoch = row.epoch;
      last.exitStake = lovelaceToAda(row.amount);
    } else {
      runs.push({
        poolId: row.poolId,
        entryEpoch: row.epoch,
        entryStake: lovelaceToAda(row.amount),
        exitEpoch: row.epoch,
        exitStake: lovelaceToAda(row.amount),
      });
    }
  }
  if (runs.length) {
    const lastRun = runs[runs.length - 1];
    if (lastRun.poolId === (acct ? acct.pool_id : null)) lastRun.isCurrent = true;
  }

  // Origin = the pool they were in immediately before first joining us.
  let cameFrom = null;
  const firstUsIdx = runs.findIndex((r) => r.poolId === _poolBech32);
  if (firstUsIdx > 0) cameFrom = runs[firstUsIdx - 1].poolId;

  return {
    stake,
    balance: acct ? lovelaceToAda(acct.controlled_amount) : null,
    rewardsSum: acct ? lovelaceToAda(acct.rewards_sum) : null,
    withdrawalsSum: acct ? lovelaceToAda(acct.withdrawals_sum) : null,
    withdrawable: acct ? lovelaceToAda(acct.withdrawable_amount) : null,
    sinceEpoch: acct && acct.active_epoch != null ? Number(acct.active_epoch) : null,
    drepId: acct ? acct.drep_id : null,
    currentPool: acct ? acct.pool_id : null,
    cameFrom,
    runs,                                       // pool-runs with entry/exit per pool
  };
}

/** POOL_LIFECYCLE — registration / retirement history (from pool summary + updates). */
async function getPoolLifecycle() {
  const [live, updates, retires] = await Promise.all([
    getPoolLive(),
    bfGet(`/pools/${_poolBech32}/updates`, []),
    bfGet(`/pools/${_poolBech32}/retirements`, []),
  ]);
  return {
    registrations: live ? live.registrations : [],
    updates: Array.isArray(updates) ? updates : [],
    retirements: Array.isArray(retires) ? retires : [],
  };
}

// Pool ticker/name cache — a pool's metadata is effectively static, so resolve
// once and reuse. Used to label the migration-trail graphic with readable names
// ("BLOOM") instead of bech32 hashes. Returns { ticker, name } or null.
const _poolMetaCache = new Map();
export async function getPoolMeta(poolId) {
  if (!poolId) return null;
  if (_poolMetaCache.has(poolId)) return _poolMetaCache.get(poolId);
  let meta = null;
  try {
    const m = await bfGet(`/pools/${poolId}/metadata`, null);
    if (m && (m.ticker || m.name)) meta = { ticker: m.ticker || null, name: m.name || null };
  } catch { /* leave null */ }
  _poolMetaCache.set(poolId, meta);
  return meta;
}

// ============================================================
// Capability-registry source (optional — registers only with a key)
// ============================================================

const PROVIDES = [
  DataKind.POOL_LIVE,
  DataKind.DELEGATOR_LIST,
  DataKind.DELEGATOR_DETAIL,
  DataKind.POOL_LIFECYCLE,
];

export const blockfrostSource = {
  id: 'blockfrost',
  label: 'Blockfrost',
  isCli: false,
  provides: () => (_reachable ? PROVIDES : []),
  reachable: () => _reachable,
  version: () => 'blockfrost.io',
  get: async (kind, params = {}) => {
    switch (kind) {
      case DataKind.POOL_LIVE:         return getPoolLive();
      case DataKind.DELEGATOR_LIST:    return getDelegatorList();
      case DataKind.DELEGATOR_DETAIL:  return getDelegatorDetail(params.stake, params.currentEpoch);
      case DataKind.POOL_LIFECYCLE:    return getPoolLifecycle();
      default: throw new Error(`blockfrost source can't provide ${kind}`);
    }
  },
};

/**
 * Initialise the OPTIONAL Blockfrost source. No-op (returns false) if no key is
 * configured — the app then runs on db-sync/Koios as normal. With a key, probes
 * /health and registers into the capability spine on success.
 */
export async function initBlockfrost(poolBech32) {
  _poolBech32 = poolBech32;
  _key = loadKey();
  _reachable = false;
  if (!_key) { console.log('[blockfrost] no key configured — optional source not enabled'); return false; }
  try {
    const out = await runCmd(`curl -sf --max-time 6 -H 'project_id: ${_key}' '${BF_BASE}/health'`);
    const h = parseJson(out, null);
    _reachable = !!(h && h.is_healthy);
    if (!_reachable) { console.warn('[blockfrost] key present but not healthy/invalid'); return false; }
    if (!registry.all().some((s) => s.id === 'blockfrost')) registry.register(blockfrostSource);
    console.log('[blockfrost] enabled — delegator/account enrichment available');
    return true;
  } catch (err) {
    console.warn('[blockfrost] init failed:', err.message ?? err);
    return false;
  }
}

export function resetBlockfrost() { _reachable = false; _poolBech32 = null; }
