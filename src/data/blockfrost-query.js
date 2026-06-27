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

/** Current delegated pool per account (for leaver classification).
 *  Returns Map(stake -> pool_id bech32 | null). One /accounts/{stake} each;
 *  only called for the (rare) set of leavers, so cost is negligible. */
export async function getAccountsDelegatedPool(stakes) {
  const out = new Map();
  for (const s of (stakes || [])) {
    try {
      // Read the latest delegation CERTIFICATE (immediate), not /accounts.pool_id
      // (the active delegation, which lags the cert by up to ~2 epochs). The most
      // recent cert's pool_id is where the delegator just moved - what db-sync sees.
      const certs = await bfGet(`/accounts/${s}/delegations?order=desc&count=1`, []);
      const latest = Array.isArray(certs) && certs.length ? certs[0] : null;
      if (latest && latest.pool_id) { out.set(s, latest.pool_id); continue; }
      // Fallback to the active pool if no cert came back.
      const a = await bfGet(`/accounts/${s}`, null);
      out.set(s, (a && a.pool_id) ? a.pool_id : null);
    } catch { out.set(s, null); }
  }
  return out;
}

/** Pool tickers for a set of pool ids. Reuses the cached getPoolMeta.
 *  Returns Map(id -> ticker | null), matching the Koios signature. */
export async function getPoolTickers(ids) {
  const out = new Map();
  for (const id of (ids || [])) {
    try { const m = await getPoolMeta(id); out.set(id, m && m.ticker ? m.ticker : null); }
    catch { out.set(id, null); }
  }
  return out;
}

// ============================================================
/** EPOCH_BLOCKS (+ epoch stake/delegators/rewards) — full per-epoch history.
 *  Paginates /pools/{id}/history (100 epochs/page, ~4 calls for full history,
 *  cached by the read-model after). Maps to the canonical epoch row. ideal/ros
 *  luck columns are filled later (Stage 3) to avoid a per-epoch call burst. */
async function getPoolHistory(from, to) {
  const rows = [];
  const _params = await ensureBfParams();           // current params (fallback)
  const _timeline = await buildParamTimeline();     // historical param change-points
  const _ownerStake = await buildOwnerStake();      // pledge active stake per epoch
  for (let page = 1; page <= 20; page++) {     // 2000 epochs max; stop on short page
    const part = await bfGet(`/pools/${_poolBech32}/history?count=100&page=${page}&order=asc`, []);
    if (!Array.isArray(part) || part.length === 0) break;
    for (const h of part) {
      const epoch = Number(h.epoch);
      if (from != null && epoch < from) continue;
      if (to != null && epoch > to) continue;
      const activeLov = h.active_stake != null ? Number(h.active_stake) : null;
      const rewardsLov = h.rewards != null ? Number(h.rewards) : null;   // total pool pot
      const feesLov = h.fees != null ? Number(h.fees) : null;            // operator take (fixed+margin)
      const memberLov = (rewardsLov != null && feesLov != null) ? Math.max(0, rewardsLov - feesLov) : null;
      const blocks = h.blocks != null ? Number(h.blocks) : null;
      let rewardsState = 'complete';
      if ((blocks === 0) && (rewardsLov == null || rewardsLov === 0)) rewardsState = 'zero';
      // Params actually in force at THIS epoch (on-chain cert history) - gives the
      // view's MIN FEE / MARGIN / PLEDGE breakdown the correct historical values.
      // We only supply measured member + leader rewards and the historical
      // fixedCost/margin; the History view derives the split exactly as it does
      // for db-sync/Koios (pledge = leader - minFee - marginEarn).
      const ep = paramsAtEpoch(_timeline, epoch, _params);
      // Six-column decomposition (all measured/derived, no approximation):
      //   member = rewards - fees ; minFee = min(fixedCost, fees) ;
      //   margin = fees - minFee ; pledge = ownerStake x (member/activeStake) ;
      //   deleg = member - pledge.
      const memberAda = lovelaceToAda(memberLov);
      const feesAda = lovelaceToAda(feesLov);
      let bfMinFee = null, bfMargin = null, bfPledge = null, bfDeleg = memberAda;
      if (feesAda != null) {
        const fc = (ep && ep.fixedCost != null) ? ep.fixedCost : 0;
        bfMinFee = Math.min(fc, feesAda);
        bfMargin = Math.max(0, feesAda - bfMinFee);
      }
      if (memberAda != null && activeLov && activeLov > 0) {
        const ownerLov = _ownerStake.get(epoch);
        if (ownerLov != null && ownerLov > 0) {
          bfPledge = memberAda * (ownerLov / activeLov);   // pledge's share of member pot
          bfDeleg = Math.max(0, memberAda - bfPledge);
        }
      }
      rows.push({
        epoch,
        adopted: blocks, confirmed: blocks, leader: null, lost: null,
        delegators: h.delegators_count != null ? Number(h.delegators_count) : null,
        activeStake: lovelaceToAda(activeLov),
        activeStakeLovelace: activeLov,
        memberRewards: memberAda,
        delegRewards: memberAda,
        leaderReward: feesAda,
        margin: ep ? ep.margin : null,
        fixedCost: ep ? ep.fixedCost : null,
        // Pre-computed accurate breakdown for the History view (Blockfrost path).
        bfMinFee, bfMargin, bfPledge, bfDeleg,
        bfTotal: lovelaceToAda(rewardsLov),
        ideal: null,         // Stage 3 fills luck (cached per epoch)
        saturation: h.active_size != null ? Number(h.active_size) * 100 : null,  // fraction → percent
        ros: null,
        rewardsState,
        source: 'blockfrost',
      });
    }
    if (part.length < 100) break;
  }
  rows.sort((a, b) => a.epoch - b.epoch);
  // Fill ideal blocks (and thus luck) per epoch from network stake + blocks.
  // Cached permanently per epoch; only epochs with pool active stake are fetched.
  for (const r of rows) {
    if (r.ideal != null) continue;
    if (!r.activeStakeLovelace || r.activeStakeLovelace <= 0) continue;
    try {
      const net = await getNetworkInfo(r.epoch);
      if (net && net.stakeLov > 0) {
        // ideal = sigma x expected blocks/epoch (432000 slots x f=0.05 = 21600).
        // NOT actual minted blocks (net.blocks) - that under-counts the ideal.
        const EXPECTED_BLOCKS_PER_EPOCH = 432000 * 0.05;   // 21600
        const sigma = r.activeStakeLovelace / net.stakeLov;
        r.ideal = sigma * EXPECTED_BLOCKS_PER_EPOCH;
      }
    } catch { /* leave ideal null for this epoch */ }
  }
  return rows;
}

/** POOL_PARAMS — margin, fixed cost, pledge from /pools/{id}. ~1 call.
 *  Also cached in _bfParams so getPoolHistory can stamp each epoch row with the
 *  fixed cost + margin the History view needs for the operator-reward breakdown. */
let _bfParams = null;
async function getPoolParams() {
  const p = await bfGet(`/pools/${_poolBech32}`, null);
  if (!p) return null;
  _bfParams = {
    margin: p.margin_cost != null ? Number(p.margin_cost) : null,
    fixedCost: lovelaceToAda(p.fixed_cost),
    declaredPledge: lovelaceToAda(p.declared_pledge),
  };
  return _bfParams;
}
async function ensureBfParams() {
  if (_bfParams) return _bfParams;
  try { return await getPoolParams(); } catch { return null; }
}

// ---- Parameter timeline (historically-accurate pledge/margin/fixed cost) ----
// Reconstructs the pool's parameter history from its on-chain registration and
// update certs so per-epoch reward breakdowns use the values that were actually
// in force - not today's. Built once, cached.
let _bfParamTimeline = null;       // sorted ascending by fromEpoch
async function buildParamTimeline() {
  if (_bfParamTimeline) return _bfParamTimeline;
  const timeline = [];
  try {
    // All registration/update certs for the pool (oldest first).
    const updates = await bfGet(`/pools/${_poolBech32}/updates?order=asc`, []);
    for (const u of (Array.isArray(updates) ? updates : [])) {
      if (!u || !u.tx_hash) continue;
      // The registration/update cert(s) in that tx carry the params + active epoch.
      const certs = await bfGet(`/txs/${u.tx_hash}/pool_updates`, []);
      for (const c of (Array.isArray(certs) ? certs : [])) {
        if (c.pool_id && c.pool_id !== _poolBech32) continue;   // ignore other pools in a multi-cert tx
        timeline.push({
          fromEpoch: c.active_epoch != null ? Number(c.active_epoch) : 0,
          pledge: lovelaceToAda(c.pledge),
          margin: c.margin_cost != null ? Number(c.margin_cost) : null,
          fixedCost: lovelaceToAda(c.fixed_cost),
        });
      }
    }
  } catch (e) {
    console.warn('[blockfrost] param timeline build failed, falling back to current params:', e.message ?? e);
  }
  timeline.sort((a, b) => a.fromEpoch - b.fromEpoch);
  _bfParamTimeline = timeline;
  console.log(`[blockfrost] param timeline: ${timeline.length} change-point(s)`,
    timeline.map((t) => `e${t.fromEpoch}:m${t.margin},fc${t.fixedCost},pl${t.pledge}`));
  return _bfParamTimeline;
}

// Params in force at a given epoch: the latest change-point with fromEpoch <= epoch.
function paramsAtEpoch(timeline, epoch, fallback) {
  let best = null;
  for (const t of timeline) {
    if (t.fromEpoch <= epoch) best = t; else break;
  }
  return best || fallback || { pledge: null, margin: null, fixedCost: null };
}

// ---- Network data per epoch (for ideal blocks / luck) ----------------------
// Injected meta-cache accessors (set by read-model) so settled-epoch network
// data persists across sessions and is only fetched once.
let _metaGet = null, _metaSet = null;
export function setBfMetaCache(getFn, setFn) { _metaGet = getFn; _metaSet = setFn; }

// Returns { stakeLov, blocks } for an epoch, from cache or /epochs/{n}. Cached
// permanently (settled epochs never change). null if unavailable.
async function getNetworkInfo(epoch) {
  const key = `netinfo:${epoch}`;
  if (_metaGet) {
    try {
      const cached = await _metaGet(key);
      if (cached) { const o = JSON.parse(cached); if (o && o.s) return { stakeLov: Number(o.s), blocks: Number(o.b) }; }
    } catch { /* fall through to fetch */ }
  }
  const e = await bfGet(`/epochs/${epoch}`, null);
  if (!e || e.active_stake == null || e.block_count == null) return null;
  const info = { stakeLov: Number(e.active_stake), blocks: Number(e.block_count) };
  if (_metaSet) { try { await _metaSet(key, JSON.stringify({ s: e.active_stake, b: e.block_count })); } catch { /* ignore */ } }
  return info;
}

// ---- Owner (pledge) stake per epoch ----------------------------------------
// The pledge's actual active stake each epoch = sum over the pool's owner
// stake addresses of their /accounts/{stake}/history amount for that epoch.
// Owners are read automatically from /pools/{id}; no user entry. Cached.
let _bfOwnerStake = null;     // Map<epoch, lovelace>
async function buildOwnerStake() {
  if (_bfOwnerStake) return _bfOwnerStake;
  const byEpoch = new Map();
  try {
    const pool = await bfGet(`/pools/${_poolBech32}`, null);
    const owners = (pool && Array.isArray(pool.owners)) ? pool.owners : [];
    for (const stake of owners) {
      for (let page = 1; page <= 20; page++) {
        const part = await bfGet(`/accounts/${stake}/history?count=100&page=${page}&order=asc`, []);
        if (!Array.isArray(part) || part.length === 0) break;
        for (const h of part) {
          const e = Number(h.active_epoch);
          const amt = h.amount != null ? Number(h.amount) : 0;
          byEpoch.set(e, (byEpoch.get(e) || 0) + amt);   // sum multiple owners
        }
        if (part.length < 100) break;
      }
    }
  } catch (e) {
    console.warn('[blockfrost] owner-stake build failed:', e.message ?? e);
  }
  _bfOwnerStake = byEpoch;
  console.log(`[blockfrost] owner stake: ${byEpoch.size} epochs of pledge history`);
  return _bfOwnerStake;
}

// Capability-registry source (optional — registers only with a key)
// ============================================================

/** DELEGATOR_LOYALTY - full parity with db-sync, computed per delegator from
 *  /accounts/{stake}/history. Returns the same row shape as dbsync getLoyalty so
 *  the view's scoreLoyalty() and the loyalty cache work unchanged.
 *  Cost: 1 history call per delegator (cached per-address). Logs the count. */
async function getAccountHistoryAll(stake) {
  // Cached per-address: past epochs never change. Cache key acct-hist:{stake}.
  const key = `accthist:${stake}`;
  if (_metaGet) {
    try { const c = await _metaGet(key); if (c) return JSON.parse(c); } catch { /* refetch */ }
  }
  const all = [];
  for (let page = 1; page <= 30; page++) {
    const part = await bfGet(`/accounts/${stake}/history?count=100&page=${page}&order=asc`, []);
    if (!Array.isArray(part) || part.length === 0) break;
    for (const r of part) all.push({ active_epoch: Number(r.active_epoch), amount: r.amount, pool_id: r.pool_id || null });
    if (part.length < 100) break;
  }
  // Only cache once the account has settled history (avoid caching a transient empty).
  if (_metaSet && all.length) { try { await _metaSet(key, JSON.stringify(all)); } catch { /* ignore */ } }
  return all;
}

// Pure translation of the db-sync getLoyalty SQL for one account.
function computeLoyaltyForAccount(history, poolBech32, currentEpoch) {
  const h = history
    .map((r) => ({ epoch: Number(r.active_epoch), amount: r.amount != null ? Number(r.amount) : 0, pool: r.pool_id || null }))
    .sort((a, b) => a.epoch - b.epoch);
  const mine = h.filter((r) => r.pool === poolBech32);
  if (!mine.length) return null;

  // current unbroken run with us (gaps-and-islands): walk back while consecutive.
  let runStart = mine.length - 1;
  for (let i = mine.length - 1; i > 0; i--) {
    if (mine[i].epoch - mine[i - 1].epoch === 1) runStart = i - 1; else break;
  }
  const run = mine.slice(runStart);
  const tenure = run.length;
  const sinceEpoch = run[0].epoch;
  const curStake = Math.round(mine[mine.length - 1].amount / 1e6);

  // big drops WITH US (consecutive epochs only, matching LAG over our rows).
  const bigDrops = [];
  for (let i = 1; i < mine.length; i++) {
    if (mine[i].epoch - mine[i - 1].epoch !== 1) continue;
    const prev = mine[i - 1].amount, now = mine[i].amount;
    if (prev != null && now < prev * 0.5) bigDrops.push({ dropEpoch: mine[i].epoch, newAmt: now, prevAmt: prev });
  }

  // reduction factor: worst (fraction pulled x recency), halflife 36 epochs.
  let reductionFactor = 0;
  for (const d of bigDrops) {
    const frac = 1 - (d.newAmt / (d.prevAmt || 1));
    const recency = 36 / (36 + (currentEpoch - d.dropEpoch));
    reductionFactor = Math.max(reductionFactor, frac * recency);
  }

  // defection: a big drop where >=50% of lost stake appears at another pool
  // within 1 epoch (first such drop, matching DISTINCT ON ... ORDER BY drop_epoch).
  let defected = false, defectToPool = null, defectEpoch = null, defectToAda = null;
  for (const d of bigDrops) {
    const lost = d.prevAmt - d.newAmt;
    const cand = h.find((r) => r.pool && r.pool !== poolBech32
      && r.epoch >= d.dropEpoch && r.epoch <= d.dropEpoch + 1
      && r.amount >= lost * 0.5);
    if (cand) { defected = true; defectToPool = cand.pool; defectEpoch = d.dropEpoch; defectToAda = Math.round(cand.amount / 1e6); break; }
  }

  return { tenure, sinceEpoch, curStake, reductionFactor, defected, defectToPool, defectEpoch, defectToAda };
}

async function getDelegatorLoyalty() {
  const list = await getDelegatorList();
  // current epoch from the network info we already fetch elsewhere; fall back to
  // the max epoch seen in the first delegator's history.
  let currentEpoch = 0;
  const t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
  let calls = 0;
  const rows = [];
  for (const d of list) {
    const stake = d.stake;
    if (!stake) continue;
    let hist = [];
    try { hist = await getAccountHistoryAll(stake); calls++; } catch { hist = []; }
    if (!hist.length) continue;
    if (!currentEpoch) currentEpoch = hist.reduce((m, r) => Math.max(m, Number(r.active_epoch)), 0);
    const loy = computeLoyaltyForAccount(hist, _poolBech32, currentEpoch);
    if (loy) rows.push({ stake, ...loy });
  }
  rows.sort((a, b) => b.tenure - a.tenure);
  const ms = Math.round(((typeof performance !== 'undefined') ? performance.now() : Date.now()) - t0);
  console.log(`[blockfrost] loyalty: ${rows.length} delegators, ${calls} history calls in ${ms}ms`);
  return rows;
}

const PROVIDES = [
  DataKind.POOL_LIVE,
  DataKind.DELEGATOR_LIST,
  DataKind.DELEGATOR_LOYALTY,
  DataKind.DELEGATOR_DETAIL,
  DataKind.POOL_LIFECYCLE,
  DataKind.EPOCH_BLOCKS,
  DataKind.EPOCH_STAKE,
  DataKind.EPOCH_DELEGATORS,
  DataKind.EPOCH_REWARDS,
  DataKind.EPOCH_IDEAL,
  DataKind.POOL_PARAMS,
  DataKind.DELEGATOR_LIST_LIVE,
  DataKind.DELEGATOR_STAKE_HISTORY,
];

/** DELEGATOR_LIST_LIVE — current delegators for the notification poller.
 *  Reuses getDelegatorList (paginated /pools/{id}/delegators, no per-account
 *  calls) and stamps the current epoch. latestDelegTx is null on Blockfrost
 *  (the leave/join is still detected; only that enrichment is absent). */
let _bfLatestEpoch = 0;
let _bfLatestEpochAt = 0;
async function bfCurrentEpoch() {
  // Cache for 60s so rapid polls don't each hit /blocks/latest.
  const now = Date.now();
  if (_bfLatestEpoch && (now - _bfLatestEpochAt) < 60_000) return _bfLatestEpoch;
  const b = await bfGet('/blocks/latest', null);
  if (b && b.epoch != null) { _bfLatestEpoch = Number(b.epoch); _bfLatestEpochAt = now; }
  return _bfLatestEpoch || null;
}
async function getDelegatorListLive() {
  const list = await getDelegatorList();
  const epoch = await bfCurrentEpoch();
  return list.map((d) => ({
    stake: d.stake,
    liveStake: d.liveStake,
    liveStakeLovelace: d.liveStakeLovelace,
    latestDelegTx: null,
    activeEpochNo: epoch,
    isOwner: d.isOwner,
  }));
}

/** DELEGATOR_STAKE_HISTORY - per-epoch active-stake series, reshaped from the
 *  internal cache-aware fetch. Epoch-grained (no intra-epoch events). */
async function getStakeHistoryDetail(stake, currentEpoch) {
  if (!stake) return null;
  const hist = await getDelegatorStakeHistory(stake, currentEpoch);   // [{epoch, poolId, amount}]
  const rows = Array.isArray(hist) ? hist.slice().sort((a, b) => a.epoch - b.epoch) : [];
  const epochs = [];
  let prev = null;
  for (const r of rows) {
    const bal = lovelaceToAda(r.amount);
    const delta = (prev == null || bal == null) ? null : (bal - prev);
    epochs.push({ epoch: r.epoch, stake: bal, delta, runningBalance: bal });
    prev = bal;
  }
  return { stake, source: 'blockfrost', granularity: 'epoch', epochs, events: [] };
}

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
      case DataKind.DELEGATOR_LIST_LIVE: return getDelegatorListLive();
      case DataKind.DELEGATOR_LOYALTY: return getDelegatorLoyalty();
      case DataKind.DELEGATOR_DETAIL:  return getDelegatorDetail(params.stake, params.currentEpoch);
      case DataKind.DELEGATOR_STAKE_HISTORY: return getStakeHistoryDetail(params.stake, params.currentEpoch);
      case DataKind.POOL_LIFECYCLE:    return getPoolLifecycle();
      case DataKind.EPOCH_BLOCKS:
      case DataKind.EPOCH_STAKE:
      case DataKind.EPOCH_DELEGATORS:
      case DataKind.EPOCH_REWARDS:
      case DataKind.EPOCH_IDEAL:       return getPoolHistory(params.from, params.to);
      case DataKind.POOL_PARAMS:       return getPoolParams();
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
    // Health probe runs over the (possibly SSH) connection to an external API,
    // so a single attempt can time out spuriously. Try twice before giving up.
    let h = null;
    for (let attempt = 0; attempt < 2 && !(h && h.is_healthy); attempt++) {
      try {
        const out = await runCmd(`curl -sf --max-time 9 -H 'project_id: ${_key}' '${BF_BASE}/health'`);
        h = parseJson(out, null);
      } catch (e) { if (attempt === 1) throw e; }
    }
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
