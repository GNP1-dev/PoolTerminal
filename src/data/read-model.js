/**
 * PoolTerminal — read-model collector.
 *
 * Fills PoolTerminal's local SQLite cache (the Rust `cache_*` commands) from
 * read-only node + Koios queries, so HISTORY / DELEGATORS views grow richer
 * over time. See MANUAL.md §4 for the full source map. Nothing here writes to
 * the node — the only mutable store is the host-local DB.
 *
 * Three jobs, each throttled and fire-and-forget (called from the 1 Hz loop;
 * never gates a snapshot):
 *   - backfillIfNeeded()        : one Koios pool_history call → seed every past
 *                                 epoch into epoch_snapshots (first run only).
 *   - refreshSemiLive()         : every ~3 min, sample live_stake / delegators /
 *                                 saturation / pledge into the samples table.
 *   - refreshBlockProduction()  : leadership-schedule once per epoch (assigned)
 *                                 + Koios produced count periodically → the
 *                                 Leader / Adopt / Confirmed / Lost / Luck cards,
 *                                 also snapshotted to epoch_snapshots.
 *
 * Authoritative-source rules (MANUAL §4.3):
 *   - Ideal / Leader  → cardano-cli (stakeGo / leadership-schedule). Current epoch.
 *   - Adopt / Confirm → Koios canonical block count (cncli chain table later).
 *   - History         → Koios pool_history.
 */

import { invoke } from './tauri.js';
import { getSession, getNodeProbe } from './session.js';
import { probeNode } from './node-probe.js';
import * as koios from './koios-query.js';
import * as dbsync from './dbsync-query.js';

// ============================================================
// History data source selector (architecture note §6)
// ============================================================
// Which source populates the HISTORY cache: 'dbsync' | 'koios' | 'off'.
// db-sync = local/remote Postgres, no rate limits, full reward split. Koios is
// kept (kill-switched) as the fallback for operators without db-sync. Eventually
// set by the wizard/settings; for now db-sync (validated, working).
const DATA_SOURCE = 'dbsync';
// db-sync connection — peer auth on the local box needs only the DB name; the
// wizard/settings will populate host/port/user/password for remote setups.
const DBSYNC_CONFIG = { database: 'cexplorer' };

// ============================================================
// Koios transport switch
// ============================================================
// When false, every Koios-dependent collector is a no-op: no external calls,
// no rate-limit risk. Node-direct live data (tip, KES, peers, mempool, chain
// pulse, cli Ideal) is unaffected; HISTORY shows whatever is already cached.
// Temporarily OFF while the public free-tier cooldown clears. This is also the
// first piece of the planned transport selector (node / host / off) — flip to
// true (or wire to a setting) to re-enable.
const KOIOS_ENABLED = false;

// ============================================================
// bech32 (pool id hex → pool1...) — portable, offline, no deps
// ============================================================

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= BECH32_GEN[i];
  }
  return chk >>> 0;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >>> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}

function bech32Checksum(hrp, data) {
  const values = bech32HrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
  const mod = bech32Polymod(values) ^ 1;
  const out = [];
  for (let i = 0; i < 6; i++) out.push((mod >>> (5 * (5 - i))) & 31);
  return out;
}

function convertBits(data, fromBits, toBits, pad) {
  let acc = 0, bits = 0;
  const ret = [];
  const maxv = (1 << toBits) - 1;
  for (const value of data) {
    acc = ((acc << fromBits) | value) & 0xffffffff;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >>> bits) & maxv);
    }
  }
  if (pad && bits > 0) ret.push((acc << (toBits - bits)) & maxv);
  return ret;
}

function hexToBytes(hex) {
  const bytes = [];
  for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.substr(i, 2), 16));
  return bytes;
}

/** Encode a 28-byte pool id hex string as a bech32 `pool1...` id. */
export function poolHexToBech32(hex) {
  const data = convertBits(hexToBytes(hex), 8, 5, true);
  const combined = data.concat(bech32Checksum('pool', data));
  let ret = 'pool1';
  for (const d of combined) ret += BECH32_CHARSET.charAt(d);
  return ret;
}

// ============================================================
// node / cli helpers (mirror live.js semantics exactly)
// ============================================================

function env() { return getSession().envVars || {}; }
function poolHex() { return (env().POOL_ID || '').toLowerCase(); }

async function runCmd(command) {
  const r = await invoke('ssh_run', { command });
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    if (typeof r.exit_code === 'number' && r.exit_code !== 0) {
      throw new Error(`ssh_run exit ${r.exit_code}: ${(r.stderr || r.stdout || '').slice(0, 400)}`);
    }
    return r.stdout ?? '';
  }
  return String(r);
}

function cliCmd(args) {
  const e = env();
  return `CARDANO_NODE_SOCKET_PATH=${e.CARDANO_NODE_SOCKET_PATH} ${e.CCLI} ${args} ${e.NETWORK_IDENTIFIER || '--mainnet'}`;
}

// ============================================================
// cache wrappers (defensive; never throw into the loop)
// ============================================================

async function cachePutEpoch(epoch, data) {
  try { await invoke('cache_put_epoch', { poolId: poolHex(), epoch, data }); }
  catch (e) { console.warn('[read-model] cache_put_epoch:', e.message ?? e); }
}
async function cacheGetEpochsRaw(fromEpoch, toEpoch) {
  try { return (await invoke('cache_get_epochs', { poolId: poolHex(), fromEpoch, toEpoch })) || []; }
  catch (e) { console.warn('[read-model] cache_get_epochs:', e.message ?? e); return []; }
}
async function cachePutSample(metric, value) {
  try { await invoke('cache_put_sample', { poolId: poolHex(), metric, value }); }
  catch (e) { console.warn('[read-model] cache_put_sample:', e.message ?? e); }
}
async function cacheGetSamplesRaw(metric, sinceTs) {
  try { return (await invoke('cache_get_samples', { poolId: poolHex(), metric, sinceTs })) || []; }
  catch (e) { console.warn('[read-model] cache_get_samples:', e.message ?? e); return []; }
}
async function cacheMetaGet(key) {
  try { return await invoke('cache_meta_get', { key }); }
  catch (e) { console.warn('[read-model] cache_meta_get:', e.message ?? e); return null; }
}
async function cacheMetaSet(key, value) {
  try { await invoke('cache_meta_set', { key, value }); }
  catch (e) { console.warn('[read-model] cache_meta_set:', e.message ?? e); }
}

// ============================================================
// pool identity
// ============================================================

let _bech32 = null;
function ensurePoolBech32() {
  if (_bech32) return _bech32;
  const hex = poolHex();
  if (!/^[0-9a-f]{56}$/.test(hex)) {
    console.warn('[read-model] POOL_ID is not a 28-byte hex pool id:', hex);
    return null;
  }
  _bech32 = poolHexToBech32(hex);
  console.log('[read-model] pool bech32:', _bech32);
  return _bech32;
}

// ============================================================
// 1. Backfill (first run only)
// ============================================================

// Bump to force a one-time rebuild of all epoch rows after a data-shape fix.
// v2: store raw active_stake lovelace; ideal recomputed via epoch_info filler.
// v4: store margin + fixedCost; leaderReward filled via account_rewards.
const BACKFILL_VERSION = '4';

let _backfillInFlight = false;
let _backfillDone = false;

// Operator reward address (for account_rewards leader lookups), resolved once.
let _rewardAddr = null;
async function ensureRewardAddr() {
  if (_rewardAddr) return _rewardAddr;
  const info = liveInfo() || (ensurePoolBech32() ? await koios.getPoolInfo(ensurePoolBech32()) : null);
  _rewardAddr = info ? info.rewardAddr : null;
  return _rewardAddr;
}

function historyRow(h) {
  return {
    epoch:               h.epoch,
    activeStake:         h.activeStake,                       // ADA, for display
    activeStakeLovelace: h.raw ? h.raw.active_stake : null,   // raw, σ denominator
    delegators:          h.delegators,
    adopted:             h.blockCount,
    confirmed:           h.blockCount,                        // Koios counts canonical only
    ideal:               h.ideal,                             // null for old epochs → filler computes
    saturation:          h.saturation,
    ros:                 h.ros,
    delegRewards:        h.delegRewards,                      // gross delegator pot (pre-fee)
    memberRewards:       h.memberRewards,                     // net to delegators
    margin:              h.margin,                            // for reward split
    fixedCost:           h.fixedCost,                         // ADA, for reward split
    // leaderReward intentionally absent → enrich filler fetches via account_rewards
    leader:              null,                                // assignment is forward-only
    lost:                null,
    source:              'koios_history',
  };
}

/** Compute Ideal for one history row from epoch_info, or leave null on failure. */
async function computeIdeal(row) {
  if (!row.activeStakeLovelace) return null;
  const ei = await koios.getEpochInfo(row.epoch);
  if (!ei || !ei.networkActiveStakeRaw) return null;
  const sigma = Number(row.activeStakeLovelace) / Number(ei.networkActiveStakeRaw);
  return Math.round(sigma * (ei.blkCount || 21600) * 100) / 100;
}

export async function backfillIfNeeded() {
  if (!KOIOS_ENABLED) return;
  if (_backfillDone || _backfillInFlight) return;
  _backfillInFlight = true;
  try {
    if ((await cacheMetaGet('backfill_version')) === BACKFILL_VERSION) { _backfillDone = true; return; }
    const bech32 = ensurePoolBech32();
    if (!bech32) return;

    const hist = await koios.getPoolHistory(bech32, { limit: 0 });
    if (!hist.length) return;

    // INSERT-OR-REPLACE overwrites existing rows in place — no wipe needed.
    // Ideal stays null for epochs Koios didn't compute a pct for; the filler
    // backfills those from epoch_info so this pass stays fast (one Koios call).
    for (const h of hist) await cachePutEpoch(h.epoch, historyRow(h));

    await cacheMetaSet('backfill_version', BACKFILL_VERSION);
    await cacheMetaSet('backfill_high_epoch', String(Math.max(...hist.map((h) => h.epoch))));
    _backfillDone = true;
    console.log(`[read-model] backfilled ${hist.length} epochs (ideal fills in next)`);
  } catch (err) {
    console.warn('[read-model] backfill failed:', err.message ?? err);
  } finally {
    _backfillInFlight = false;
  }
}

// ---- Enrich filler ---------------------------------------------------------
// Fills two per-epoch fields pool_history can't give directly:
//   • ideal       — from epoch_info (active_stake_pct is null for old epochs).
//   • leaderReward — operator reward from account_rewards (for the SPO split).
// Both are finalised facts for closed epochs, computed once each. leaderReward
// is only sought for epochs old enough to have published rewards (≤ max-2);
// recent ones get it via refreshRecent. Small batches per tick — never stalls.
const IDEAL_FILL_MS = 4000;
const IDEAL_FILL_BATCH = 8;
let _idealFillAt = 0;
let _idealFillInFlight = false;
let _idealFillDone = false;

export async function refreshIdealFiller() {
  if (!KOIOS_ENABLED) return;
  if (!_backfillDone || _idealFillDone || _idealFillInFlight) return;
  const now = Date.now();
  if (_idealFillAt && now - _idealFillAt < IDEAL_FILL_MS) return;
  _idealFillInFlight = true;
  _idealFillAt = now;
  try {
    const rows = await cacheGetEpochsRaw(0, 9_999_999);
    const maxEpoch = rows.reduce((m, r) => Math.max(m, r.epoch), 0);
    const rewardCutoff = maxEpoch - 2;   // rewards published for epochs at/below this

    const needIdeal = (r) => r.data && r.data.ideal == null && r.data.activeStakeLovelace;
    const needLeader = (r) =>
      r.data && r.data.source === 'koios_history' &&
      r.data.leaderReward === undefined && r.epoch <= rewardCutoff;

    const need = rows.filter((r) => needIdeal(r) || needLeader(r));
    if (!need.length) {
      _idealFillDone = true;
      console.log('[read-model] enrich fill complete (ideal + leader rewards)');
      return;
    }

    const addr = await ensureRewardAddr();
    for (const r of need.slice(0, IDEAL_FILL_BATCH)) {
      const d = { ...r.data };
      let changed = false;
      if (needIdeal(r)) {
        const ideal = await computeIdeal(d);
        if (ideal != null) { d.ideal = ideal; changed = true; }
      }
      if (needLeader(r) && addr) {
        const lr = await koios.getLeaderReward(addr, r.epoch);
        if (lr != null) { d.leaderReward = lr; changed = true; }   // 0 is valid (zero-block epoch)
      }
      if (changed) await cachePutEpoch(r.epoch, d);
    }
    console.log(`[read-model] enrich fill: ~${Math.max(0, need.length - IDEAL_FILL_BATCH)} epochs remaining`);
  } catch (err) {
    console.warn('[read-model] enrich fill failed:', err.message ?? err);
  } finally {
    _idealFillInFlight = false;
  }
}

// ---- Recent refresh --------------------------------------------------------
// pool_history LAGS (it omits the last epoch or two), but pool_blocks is
// near-real-time. So for recent CLOSED epochs we take the block count from
// pool_blocks (finalised on-chain immediately) and, where pool_history hasn't
// aggregated the epoch yet, show ONLY what's finalised (blocks) — every other
// field stays null → '—' in the UI until pool_history publishes it. The current
// (in-progress) epoch is owned by refreshBlockProduction, so it's excluded here.
const RECENT_MS = 5 * 60 * 1000;
let _recentAt = 0;
let _recentInFlight = false;

export async function refreshRecent(currentEpoch) {
  if (!KOIOS_ENABLED) return;
  if (!_backfillDone || _recentInFlight || !currentEpoch) return;
  const now = Date.now();
  if (_recentAt && now - _recentAt < RECENT_MS) return;
  _recentInFlight = true;
  _recentAt = now;
  try {
    const bech32 = ensurePoolBech32();
    if (!bech32) return;

    const hist = await koios.getPoolHistory(bech32, { limit: 8 });
    const byEpoch = new Map(hist.map((h) => [h.epoch, h]));

    for (let e = currentEpoch - 1; e >= currentEpoch - 6; e--) {
      const blocks = await koios.getEpochBlockCount(bech32, e);   // finalised on-chain
      const h = byEpoch.get(e);
      if (h) {
        // pool_history has aggregated this epoch — full row, freshest block count.
        const row = historyRow(h);
        row.adopted = blocks;
        row.confirmed = blocks;
        if (row.ideal == null) row.ideal = await computeIdeal(row);
        const addr = await ensureRewardAddr();
        if (addr) {
          const lr = await koios.getLeaderReward(addr, e);   // null if not published yet
          if (lr != null) row.leaderReward = lr;
        }
        await cachePutEpoch(e, row);
      } else {
        // Closed epoch Koios hasn't aggregated yet: show ONLY finalised facts
        // (blocks). Ideal needs the pool's active stake (only in pool_history),
        // so it stays null too — no placeholders, fills in when published.
        await cachePutEpoch(e, {
          epoch: e,
          adopted: blocks, confirmed: blocks,
          ideal: null, leader: null, lost: null,
          delegators: null, activeStake: null, activeStakeLovelace: null,
          saturation: null, ros: null, delegRewards: null, memberRewards: null,
          source: 'blocks_only',
        });
      }
    }
    console.log(`[read-model] recent refresh: epochs ${currentEpoch - 6}–${currentEpoch - 1} (pool_blocks overlay)`);
  } catch (err) {
    console.warn('[read-model] recent refresh failed:', err.message ?? err);
  } finally {
    _recentInFlight = false;
  }
}

// ============================================================
// 2. Semi-live samples
// ============================================================

const SAMPLE_MS = 3 * 60 * 1000;
let _sampleAt = 0;
let _sampleInFlight = false;
let _lastInfo = null;

export async function refreshSemiLive() {
  if (!KOIOS_ENABLED) return;
  if (_sampleInFlight) return;
  const now = Date.now();
  if (_sampleAt !== 0 && now - _sampleAt < SAMPLE_MS) return;
  _sampleInFlight = true;
  _sampleAt = now;
  try {
    const bech32 = ensurePoolBech32();
    if (!bech32) return;
    const info = await koios.getPoolInfo(bech32);
    if (!info) return;
    _lastInfo = info;
    if (info.liveStake != null)      await cachePutSample('live_stake', info.liveStake);
    if (info.liveDelegators != null) await cachePutSample('delegators', info.liveDelegators);
    if (info.liveSaturation != null) await cachePutSample('saturation', info.liveSaturation);
    if (info.livePledge != null)     await cachePutSample('live_pledge', info.livePledge);
    console.log(`[read-model] sampled live_stake=${info.liveStake} delegators=${info.liveDelegators}`);
  } catch (err) {
    console.warn('[read-model] semi-live sample failed:', err.message ?? err);
  } finally {
    _sampleInFlight = false;
  }
}

/** Last Koios pool_info (live stake, delegators, saturation, pledge) or null. */
export function liveInfo() { return _lastInfo; }

// ============================================================
// 3. Block production (current epoch)
// ============================================================

const PRODUCED_REFRESH_MS = 3 * 60 * 1000;
let _bp = null;
let _bpInFlight = false;
let _bpScheduleEpoch = null;   // epoch the leadership-schedule last ran for
let _bpAssigned = null;        // array of assigned slots, or null if unknown
let _bpProducedAt = 0;
let _bpProduced = 0;
let _bpInfoWritten = false;

/** Run leadership-schedule --current, paths derived from the node probe. */
async function leadershipScheduleCurrent() {
  let probe = getNodeProbe();
  if (!probe?.vrfSkeyPath || !probe?.configPath) probe = await probeNode();
  const vrf = probe?.vrfSkeyPath;
  const config = probe?.configPath;
  if (!vrf || !config) {
    console.warn('[read-model] leadership-schedule: probe missing vrf/config', { vrf, config });
    return null;
  }
  const genesis = config.replace(/\/[^/]*$/, '') + '/shelley-genesis.json';
  const cmd = cliCmd(
    `query leadership-schedule --genesis '${genesis}' ` +
    `--stake-pool-id ${poolHex()} --vrf-signing-key-file '${vrf}' --current`
  );
  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[read-model] leadership-schedule failed:', err.message ?? err);
    return null;
  }
  return parseLeadershipSchedule(out);
}

/** Parse leadership-schedule output: JSON array first, text table fallback. */
function parseLeadershipSchedule(out) {
  if (!out || !out.trim()) return [];
  const jsonStart = out.indexOf('[');
  if (jsonStart >= 0) {
    try {
      const arr = JSON.parse(out.slice(jsonStart));
      if (Array.isArray(arr)) {
        return arr.map((x) => ({ slot: x.slotNumber ?? x.slot ?? null, time: x.slotTime ?? null }));
      }
    } catch { /* fall through */ }
  }
  const slots = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d{6,})\s+(.+?)\s*$/);
    if (m) slots.push({ slot: parseInt(m[1], 10), time: m[2].trim() });
  }
  return slots;
}

export async function refreshBlockProduction(epoch, ideal) {
  if (_bpInFlight) return;
  _bpInFlight = true;
  try {
    let dirty = false;
    // Assignment: once per epoch (leadership-schedule is heavy).
    if (_bpScheduleEpoch !== epoch) {
      _bpScheduleEpoch = epoch;
      _bpAssigned = await leadershipScheduleCurrent();
      dirty = true;
    }
    // Produced: refresh periodically (blocks can appear mid-epoch).
    const now = Date.now();
    if (KOIOS_ENABLED && (_bpProducedAt === 0 || now - _bpProducedAt > PRODUCED_REFRESH_MS)) {
      _bpProducedAt = now;
      const bech32 = ensurePoolBech32();
      _bpProduced = bech32 ? await koios.getEpochBlockCount(bech32, epoch) : 0;
      dirty = true;
    }
    // Rewrite the live row once delegators/stake become available too.
    if (dirty === false && !_bpInfoWritten && liveInfo()) dirty = true;

    const leaderKnown = _bpAssigned != null;
    const leader = leaderKnown ? _bpAssigned.length : 0;
    const adopted = _bpProduced;
    const lost = leaderKnown ? Math.max(0, leader - adopted) : 0;
    const luckPercent = ideal && ideal > 0 ? Math.round((adopted / ideal) * 100) : 0;

    _bp = { leader, ideal: ideal ?? 0, adopted, confirmed: adopted, lost, luckPercent, leaderKnown };

    if (dirty) {
      const info = liveInfo();
      await cachePutEpoch(epoch, {
        epoch,
        leader: leaderKnown ? leader : null,
        ideal: ideal ?? null,
        adopted, confirmed: adopted,
        lost: leaderKnown ? lost : null,
        luck: luckPercent,
        delegators:          info ? info.liveDelegators : null,
        activeStake:         info ? info.activeStake : null,            // Set snapshot ≈ live epoch
        activeStakeLovelace: info && info.raw ? info.raw.active_stake : null,
        ros: null,
        source: 'live',
      });
      if (info) _bpInfoWritten = true;
    }
  } catch (err) {
    console.warn('[read-model] block-production refresh failed:', err.message ?? err);
  } finally {
    _bpInFlight = false;
  }
}

/** Last computed block-production card values, or null until first refresh. */
export function currentBlockProduction() { return _bp; }

// ============================================================
// View read helpers (HISTORY / DELEGATORS / charts)
// ============================================================

/** Per-epoch history records (parsed JSON payloads), ascending by epoch. */
export async function getEpochHistory(fromEpoch, toEpoch) {
  const rows = await cacheGetEpochsRaw(fromEpoch, toEpoch);
  return rows.map((r) => ({ epoch: r.epoch, capturedAt: r.captured_at, ...r.data }));
}

// ============================================================
// db-sync history source (architecture §5, §12)
// ============================================================
// Populates the same epoch_snapshots cache HISTORY reads, from local/remote
// Postgres — no rate limits, full reward split. Two phases like the Koios path:
//   1. backfill (fast): bulk-fetch blocks/stake/delegators/rewards/params, write
//      rows with ideal=null. HISTORY shows everything but ideal/luck at once.
//   2. ideal filler (background): network-stake denominator is the only heavy
//      bit (~270ms/epoch) — computed once per epoch and CACHED FOREVER in meta,
//      so history is never recomputed. ideal = netBlocks × (poolStake/netStake).

let _dbsyncInit = false;
let _dbsyncBackfillDone = false;
let _dbsyncBackfillInFlight = false;

async function ensureDbsync() {
  if (_dbsyncInit) return dbsync.dbsyncSource.reachable();
  _dbsyncInit = true;
  const ok = await dbsync.initDbsync(DBSYNC_CONFIG, poolHex());
  if (ok) {
    await cacheMetaSet('history_source', 'dbsync');
    await cacheMetaSet('dbsync_schema', dbsync.dbsyncSource.version() || '');
  }
  return ok;
}

async function backfillFromDbsync(currentEpoch) {
  if (_dbsyncBackfillDone || _dbsyncBackfillInFlight || !currentEpoch) return;
  _dbsyncBackfillInFlight = true;
  try {
    if (!(await ensureDbsync())) { console.warn('[dbsync] backfill skipped — not reachable'); return; }
    const first = await dbsync.getPoolFirstEpoch();
    const from = first || Math.max(1, currentEpoch - 500);
    const t0 = performance.now();
    const rows = await dbsync.fetchHistory(from, currentEpoch);
    for (const r of rows) await cachePutEpoch(r.epoch, r);
    _dbsyncBackfillDone = true;
    console.log(`[dbsync] backfill: ${rows.length} epochs ${from}–${currentEpoch} in ${Math.round(performance.now() - t0)}ms`);
  } catch (e) {
    console.warn('[dbsync] backfill failed:', e.message ?? e);
  } finally {
    _dbsyncBackfillInFlight = false;
  }
}

// Network active stake per epoch — the expensive ideal denominator. Computed
// once per epoch and cached in meta forever (history never changes).
async function getNetStakeCached(epoch) {
  const key = `netstake:${epoch}`;
  const cached = await cacheMetaGet(key);
  if (cached) return Number(cached);
  const v = await dbsync.getNetActiveStake(epoch);
  if (v != null) await cacheMetaSet(key, String(v));
  return v;
}

const DBSYNC_IDEAL_BATCH = 4;
const DBSYNC_IDEAL_MS = 2500;
let _dbsyncIdealAt = 0;
let _dbsyncIdealDone = false;
let _dbsyncIdealInFlight = false;

async function dbsyncIdealFiller(currentEpoch) {
  if (_dbsyncIdealDone || _dbsyncIdealInFlight || !_dbsyncBackfillDone) return;
  const now = Date.now();
  if (_dbsyncIdealAt && now - _dbsyncIdealAt < DBSYNC_IDEAL_MS) return;
  _dbsyncIdealInFlight = true;
  _dbsyncIdealAt = now;
  try {
    const rows = await cacheGetEpochsRaw(0, 9_999_999);
    // Ideal needed for closed epochs that produced blocks and have pool stake.
    const need = rows.filter((r) => r.data && r.data.source === 'dbsync'
      && r.data.ideal == null && r.data.activeStakeLovelace
      && (r.data.adopted || 0) > 0 && r.epoch < currentEpoch);
    if (!need.length) { _dbsyncIdealDone = true; console.log('[dbsync] ideal fill complete'); return; }
    const lo = need[0].epoch, hi = need[need.length - 1].epoch;
    const netBlocks = await dbsync.getNetBlocks(lo, hi);
    for (const r of need.slice(0, DBSYNC_IDEAL_BATCH)) {
      const netStake = await getNetStakeCached(r.epoch);
      const nb = netBlocks[r.epoch];
      if (netStake && nb != null) {
        const sigma = Number(r.data.activeStakeLovelace) / netStake;
        const ideal = Math.round(sigma * nb * 100) / 100;
        await cachePutEpoch(r.epoch, { ...r.data, ideal });
      }
    }
    console.log(`[dbsync] ideal fill: ~${Math.max(0, need.length - DBSYNC_IDEAL_BATCH)} epochs remaining`);
  } catch (e) {
    console.warn('[dbsync] ideal fill failed:', e.message ?? e);
  } finally {
    _dbsyncIdealInFlight = false;
  }
}

/** History dispatcher — called from the live loop; routes by DATA_SOURCE. */
export async function refreshHistory(currentEpoch) {
  if (DATA_SOURCE === 'dbsync') {
    await backfillFromDbsync(currentEpoch);
    dbsyncIdealFiller(currentEpoch);   // fire-and-forget; self-throttled
  }
  // 'koios' path runs via backfillIfNeeded/refreshIdealFiller/refreshRecent
  // (gated by KOIOS_ENABLED); 'off' does nothing.
}

/** Active history source + version, for the HISTORY header. */
export async function getHistoryMeta() {
  return {
    source: (await cacheMetaGet('history_source')) || (DATA_SOURCE === 'off' ? null : DATA_SOURCE),
    schema: await cacheMetaGet('dbsync_schema'),
    tested: dbsync.DBSYNC_TESTED_SCHEMA,
    stale: dbsync.dbsyncSource.schemaStale ? dbsync.dbsyncSource.schemaStale() : false,
  };
}

/** Time-series samples for a metric since a unix timestamp. */
export async function getSamples(metric, sinceTs) {
  const rows = await cacheGetSamplesRaw(metric, sinceTs);
  return rows.map((r) => ({ t: r.captured_at, v: r.value }));
}

// ============================================================
// NODE HEALTH sampler (always-on — node-direct, never Koios-gated)
// ============================================================
// Persists host + node-process metrics to the samples table so NODE HEALTH can
// draw historical trends that fill richer over time. Throttled to ~30s — fine
// granularity for trends without bloating the table. Called from the live loop
// with the latest host scrape (host-query) and node metrics (metrics-query).
const HEALTH_SAMPLE_MS = 30_000;
let _healthAt = 0;

export async function sampleHealth(host, metrics) {
  const now = Date.now();
  if (_healthAt && now - _healthAt < HEALTH_SAMPLE_MS) return;
  if (!host && !metrics) return;
  _healthAt = now;
  const put = (m, v) => (v != null && Number.isFinite(v)) ? cachePutSample(m, v) : null;
  if (host) {
    await put('cpu_pct',         host.cpuPct);
    await put('mem_used_pct',    host.memUsedPct);
    await put('swap_used_pct',   host.swapUsedPct);
    await put('disk_used_pct',   host.diskUsedPct);
    await put('disk_free_bytes', host.diskFree);
    await put('net_rx_bps',      host.netRxBps);
    await put('net_tx_bps',      host.netTxBps);
    await put('load1',           host.load1);
  }
  if (metrics) {
    await put('rss_bytes',     metrics.rssBytes);
    await put('gc_live_bytes', metrics.gcLiveBytes);
    await put('mempool_bytes', metrics.mempoolBytes);
    await put('mempool_txs',   metrics.mempoolTxs);
    await put('peers_hot',     metrics.peersHot);
    await put('peers_warm',    metrics.peersWarm);
    await put('peers_cold',    metrics.peersCold);
    await put('density',       metrics.density);
  }
}

// ============================================================
// Lifecycle
// ============================================================

/** Reset all module state — call on connect / mode switch / reconnect. */
export function resetReadModel() {
  _bech32 = null;
  _rewardAddr = null;
  _backfillInFlight = false; _backfillDone = false;
  _idealFillAt = 0; _idealFillInFlight = false; _idealFillDone = false;
  _recentAt = 0; _recentInFlight = false;
  _sampleAt = 0; _sampleInFlight = false; _lastInfo = null;
  _bp = null; _bpInFlight = false; _bpScheduleEpoch = null; _bpAssigned = null;
  _bpProducedAt = 0; _bpProduced = 0; _bpInfoWritten = false;
  _healthAt = 0;
  _dbsyncInit = false; _dbsyncBackfillDone = false; _dbsyncBackfillInFlight = false;
  _dbsyncIdealAt = 0; _dbsyncIdealDone = false; _dbsyncIdealInFlight = false;
  dbsync.resetDbsync();
}
