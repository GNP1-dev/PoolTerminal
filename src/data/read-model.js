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
import * as koiosHist from './koios-history.js';
import * as blockfrost from './blockfrost-query.js';
// Give Blockfrost the persistent meta-cache so per-epoch network data (for luck)
// survives across sessions and is fetched only once.
if (blockfrost.setBfMetaCache) blockfrost.setBfMetaCache((k) => cacheMetaGet(k), (k, v) => cacheMetaSet(k, v));
import { DataKind, registry } from './capabilities.js';
import { getNotifPollMs, getNotifThresholdLovelace } from './notif-settings.js';

// ============================================================
// History data source selector (architecture note §6)
// ============================================================
// Which source populates the HISTORY cache: 'dbsync' | 'koios' | 'off'.
// db-sync = local/remote Postgres, no rate limits, full reward split. Koios is
// kept (kill-switched) as the fallback for operators without db-sync. Eventually
// set by the wizard/settings; for now a persisted toggle (HISTORY view) lets us
// switch dbsync↔koios for testing. Restored from localStorage on load.
let DATA_SOURCE = 'dbsync';
try {
  const saved = localStorage.getItem('pt.data_source');
  if (saved === 'dbsync' || saved === 'koios' || saved === 'off') DATA_SOURCE = saved;
} catch { /* ignore */ }

/** Current history data source ('dbsync' | 'koios' | 'off'). */
export function getDataSource() { return DATA_SOURCE; }
/** Set + persist the history data source. Caller should reload to apply. */
export function setDataSource(src) {
  if (src !== 'dbsync' && src !== 'koios' && src !== 'off') return;
  DATA_SOURCE = src;
  try { localStorage.setItem('pt.data_source', src); } catch { /* ignore */ }
}
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
const KOIOS_ENABLED = false;  // TEMP: off for Blockfrost test, restore to true for Koios call-volume work

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

// Reward fields flicker null on Koios (proven: same epoch returns a real number
// on one request, null the next). A real cached value is authoritative for a
// settled epoch and must never be overwritten by a later null/undefined. Block
// counts are likewise immutable once real. A genuine 0 is allowed through.
const _REWARD_FIELDS = ['delegRewards', 'memberRewards', 'ros', 'margin', 'fixedCost', 'leaderReward', 'adopted', 'confirmed'];
function _isRealVal(v) { return v != null; }

async function cachePutEpoch(epoch, data) {
  try {
    let merged = data;
    try {
      const existing = await invoke('cache_get_epochs', { poolId: poolHex(), fromEpoch: epoch, toEpoch: epoch });
      const prevWrap = Array.isArray(existing) && existing.length ? existing[0] : null;
      const prev = prevWrap && prevWrap.data ? prevWrap.data : prevWrap;
      if (prev) {
        merged = { ...data };
        for (const f of _REWARD_FIELDS) {
          if (!_isRealVal(merged[f]) && _isRealVal(prev[f])) merged[f] = prev[f];
        }
      }
    } catch { /* no existing row - write as-is */ }
    await invoke('cache_put_epoch', { poolId: poolHex(), epoch, data: merged });
  } catch (e) { console.warn('[read-model] cache_put_epoch:', e.message ?? e); }
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
// --- Loyalty snapshot cache (computed once per epoch; see delegators view) ---
export async function cacheGetLoyalty() {
  try { return (await invoke('cache_get_loyalty', { poolId: poolHex() })) || []; }
  catch (e) { console.warn('[read-model] cache_get_loyalty:', e.message ?? e); return []; }
}
export async function cacheLoyaltyEpoch() {
  try { return await invoke('cache_loyalty_epoch', { poolId: poolHex() }); }
  catch (e) { console.warn('[read-model] cache_loyalty_epoch:', e.message ?? e); return null; }
}
export async function cachePutLoyalty(computedEpoch, rows) {
  try { await invoke('cache_put_loyalty', { poolId: poolHex(), computedEpoch, rows }); }
  catch (e) { console.warn('[read-model] cache_put_loyalty:', e.message ?? e); }
}

// --- Notifications: live-delegator snapshot + event feed (see refreshNotifications) ---
// These call cache_* commands added in cache.rs schema v4. Defensive like the
// rest: if the command isn't present yet they degrade to [] / no-op, so this
// file is safe to deploy before the Rust side lands.
async function cacheGetNotifSnapshot() {
  try { return (await invoke('cache_get_notif_snapshot', { poolId: poolHex() })) || []; }
  catch (e) { console.warn('[read-model] cache_get_notif_snapshot:', e.message ?? e); return []; }
}
async function cachePutNotifSnapshot(rows) {
  try { await invoke('cache_put_notif_snapshot', { poolId: poolHex(), rows }); }
  catch (e) { console.warn('[read-model] cache_put_notif_snapshot:', e.message ?? e); }
}
async function cachePutNotifEvents(events) {
  try { await invoke('cache_put_notif_events', { poolId: poolHex(), events, keep: NOTIF_EVENTS_KEEP }); }
  catch (e) { console.warn('[read-model] cache_put_notif_events:', e.message ?? e); }
}
async function cacheGetNotifEvents(limit) {
  try { return (await invoke('cache_get_notif_events', { poolId: poolHex(), limit })) || []; }
  catch (e) { console.warn('[read-model] cache_get_notif_events:', e.message ?? e); return []; }
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
const BACKFILL_VERSION = '5';   // bump: re-read history to clear stale flicker-nulls

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
    reconcileRewards();   // fire-and-forget: re-query epochs whose rewards are still null
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

/** Run leadership-schedule for 'current' or 'next', paths from the node probe.
 *  '--next' only works once inside the next-epoch window (~36h before boundary,
 *  after the stake snapshot stabilises); before that the node errors, which we
 *  treat as "not available yet" (null), distinct from "window open, no slots" ([]). */
async function leadershipSchedule(which) {
  let probe = getNodeProbe();
  if (!probe?.vrfSkeyPath || !probe?.configPath) probe = await probeNode();
  const vrf = probe?.vrfSkeyPath;
  const config = probe?.configPath;
  if (!vrf || !config) {
    console.warn('[read-model] leadership-schedule: probe missing vrf/config', { vrf, config });
    return null;
  }
  const flag = which === 'next' ? '--next' : '--current';
  const genesis = config.replace(/\/[^/]*$/, '') + '/shelley-genesis.json';
  const cmd = cliCmd(
    `query leadership-schedule --genesis '${genesis}' ` +
    `--stake-pool-id ${poolHex()} --vrf-signing-key-file '${vrf}' ${flag}`
  );
  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    // For --next, an error usually means the window isn't open yet — expected.
    if (which !== 'next') console.warn('[read-model] leadership-schedule failed:', err.message ?? err);
    return null;
  }
  // The node prints a friendly error to stdout when --next isn't available yet.
  if (which === 'next' && /not.*stabilis|expected.*current|TooEarly|StakeSnapshot/i.test(out || '')) {
    return null;
  }
  return parseLeadershipSchedule(out);
}

/** Back-compat shim — current-epoch schedule (used by refreshBlockProduction). */
async function leadershipScheduleCurrent() {
  return leadershipSchedule('current');
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
    // Produced count (the live "adopted" figure) — refresh periodically (blocks
    // appear mid-epoch). ARCHITECTURE: live block production ALWAYS uses Koios
    // (works for every operator, no db-sync needed). db-sync is for HISTORY only;
    // Blockfrost is for DELEGATORS only. So this is Koios regardless of the
    // history-source toggle.
    const now = Date.now();
    if (_bpProducedAt === 0 || now - _bpProducedAt > PRODUCED_REFRESH_MS) {
      _bpProducedAt = now;
      try {
        const bech32 = ensurePoolBech32();
        if (bech32) _bpProduced = await koios.getEpochBlockCount(bech32, epoch);
      } catch (e) {
        console.warn('[bp] produced count fetch failed:', e.message ?? e);
      }
      dirty = true;
    }
    // Rewrite the live row once delegators/stake become available too.
    if (dirty === false && !_bpInfoWritten && liveInfo()) dirty = true;

    const leaderKnown = _bpAssigned != null;
    const leader = leaderKnown ? _bpAssigned.length : 0;
    const adopted = _bpProduced;
    // Lost vs pending: a leader slot whose time has passed is only LOST if it has
    // been long enough that the produced-block source (Koios/cncli) should have
    // reported it — otherwise a freshly-minted block flashes "Lost 1" during the
    // lag between the slot passing and our source catching up. So we only count a
    // slot as "settled-passed" once it's older than LOST_GRACE_MS; slots that
    // passed more recently sit in limbo (not adopted yet, not lost yet). Future
    // slots are "upcoming". lost = settledPassed − adopted (never negative).
    const LOST_GRACE_MS = 10 * 60 * 1000;   // 10 min — ample for Koios/cncli to report
    const nowMs = Date.now();
    const settledPassed = leaderKnown
      ? _bpAssigned.filter((s) => {
          const w = s && s.time ? Date.parse(s.time) : null;
          return w != null && (nowMs - w) > LOST_GRACE_MS;
        }).length
      : 0;
    const lost = leaderKnown ? Math.max(0, settledPassed - adopted) : 0;
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
// Upcoming blocks (leader slots still to come)
// ============================================================
// Shows the operator's assigned leader slots that haven't happened yet — for
// the CURRENT epoch (remaining slots) and the NEXT epoch (once the ~36h
// leadership-schedule window opens). The authority is `cardano-cli query
// leadership-schedule` (not cncli, which can carry restore-artifact phantoms).

let _ubCurEpoch = null;     // epoch the cached --current schedule is for
let _ubCurSlots = null;     // cached --current slots (array) or null
let _ubNextEpoch = null;    // epoch the cached --next schedule is for
let _ubNextSlots = null;    // cached --next slots, or null if window not open
let _ubNextCheckedAt = 0;   // last time we probed --next (retry until window opens)

const UB_NEXT_RETRY_MS = 10 * 60 * 1000;   // re-probe --next every 10 min until it opens

// Persisted schedule cache (poolterminal.db). The leadership-schedule query is
// heavy AND its result is fixed for an epoch once the snapshot stabilises, so
// we compute it at most once per epoch and persist it — subsequent loads are
// instant from cache, no slow cli call. Key: leaderlog:<epoch>:<current|next>.
async function loadCachedSchedule(epoch, which) {
  try {
    const raw = await cacheMetaGet(`leaderlog:${epoch}:${which}`);
    if (!raw) return undefined;            // not cached
    return JSON.parse(raw);                // array (possibly empty)
  } catch { return undefined; }
}
async function saveCachedSchedule(epoch, which, slots) {
  try { await cacheMetaSet(`leaderlog:${epoch}:${which}`, JSON.stringify(slots)); } catch { /* non-fatal */ }
}

/**
 * Upcoming leader slots, current + next epoch, future-only, sorted by time.
 * Each: { slot, time, epoch, when }. Cached per epoch in poolterminal.db so the
 * slow cli leadership-schedule runs at most once per epoch (current), and once
 * when the ~36h next-epoch window opens (next).
 */
export async function getUpcomingBlocks(currentEpoch) {
  const nowMs = Date.now();

  // CURRENT epoch — use persisted cache if present; else compute once + persist.
  if (currentEpoch != null && _ubCurEpoch !== currentEpoch) {
    _ubCurEpoch = currentEpoch;
    const cached = await loadCachedSchedule(currentEpoch, 'current');
    if (cached !== undefined) {
      _ubCurSlots = cached;
    } else {
      const slots = await leadershipSchedule('current');
      _ubCurSlots = slots;
      if (Array.isArray(slots)) await saveCachedSchedule(currentEpoch, 'current', slots);
    }
  }

  // NEXT epoch — persisted once the window opens; until then, retry periodically.
  const nextEpoch = currentEpoch != null ? currentEpoch + 1 : null;
  if (nextEpoch != null && _ubNextEpoch !== nextEpoch) {
    // New boundary: adopt any persisted next-epoch schedule immediately.
    _ubNextEpoch = nextEpoch;
    _ubNextSlots = undefined;
    const cached = await loadCachedSchedule(nextEpoch, 'next');
    if (cached !== undefined) _ubNextSlots = cached;
  }
  // If still not known (window not yet open / not cached), retry the cli probe.
  if (nextEpoch != null && (_ubNextSlots === undefined || _ubNextSlots === null)
      && nowMs - _ubNextCheckedAt > UB_NEXT_RETRY_MS) {
    _ubNextCheckedAt = nowMs;
    const slots = await leadershipSchedule('next');   // null if window not open yet
    if (Array.isArray(slots)) {
      _ubNextSlots = slots;
      await saveCachedSchedule(nextEpoch, 'next', slots);   // persist — window is open now
    } else {
      _ubNextSlots = null;   // still waiting
    }
  }

  const out = [];
  const pushFuture = (slots, epoch) => {
    if (!Array.isArray(slots)) return;
    for (const s of slots) {
      const when = s.time ? Date.parse(s.time) : null;
      if (when != null && when > nowMs) out.push({ slot: s.slot, time: s.time, epoch, when });
    }
  };
  pushFuture(_ubCurSlots, _ubCurEpoch);
  pushFuture(_ubNextSlots, _ubNextEpoch);
  out.sort((a, b) => a.when - b.when);
  return out;
}

/** True once we have the next-epoch schedule (window open). For loading/UI. */
export function isNextEpochWindowOpen() { return Array.isArray(_ubNextSlots); }

/** Whether the upcoming-blocks data is ready (schedule fetched or cached). For
 *  the loading screen — current-epoch schedule resolved is enough to proceed. */
export function isUpcomingReady() { return _ubCurSlots !== null && _ubCurSlots !== undefined; }



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

function savedSourceChoice() {
  try { return JSON.parse(localStorage.getItem('poolterminal.source.v1') || '{}'); } catch { return {}; }
}

// Build a db-sync config from the saved wizard/Settings choice. Returns null if
// the operator did not opt into db-sync - which is how we respect "Koios-only".
function dbsyncConfigFromChoice() {
  const c = savedSourceChoice();
  if (!c || c.useDbsync !== true) return null;
  const d = c.dbsync || {};
  const mode = c.dbsyncMode || 'local';
  const cfg = { database: d.database || 'cexplorer' };
  if (mode !== 'local') {
    cfg.host = d.host || (mode === 'tunnel' ? '127.0.0.1' : '');
    cfg.port = d.port || 5432;
    if (d.user) cfg.user = d.user;
    if (d.password) cfg.password = d.password;
    if (mode === 'tunnel') cfg.viaSsh = true;   // honoured only when SSH_TUNNEL_ENABLED
  }
  return cfg;
}

async function ensureDbsync() {
  if (_dbsyncInit) return dbsync.dbsyncSource.reachable();
  const _dbCfg = dbsyncConfigFromChoice();
  if (!_dbCfg) return false;   // user did not opt into db-sync - respect that choice
  _dbsyncInit = true;
  const ok = await dbsync.initDbsync(_dbCfg, poolHex());
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

// Network active stake per epoch — cached forever in meta (history never
// changes). Kept for any single-epoch callers; the bulk path below is used for
// the history ideal fill.
async function getNetStakeCached(epoch) {
  const key = `netstake:${epoch}`;
  const cached = await cacheMetaGet(key);
  if (cached) return Number(cached);
  const v = await dbsync.getNetActiveStake(epoch);
  if (v != null) await cacheMetaSet(key, String(v));
  return v;
}

let _dbsyncIdealDone = false;
let _dbsyncIdealInFlight = false;

// Fill the ideal column for the WHOLE history in two bulk queries (net stake
// per epoch via GROUP BY + net blocks per epoch), instead of trickling one
// epoch at a time. Runs once after backfill. Ideal is computed for every closed
// epoch that had pool stake — including zero-block epochs (luck 0% is real).
async function dbsyncIdealFiller(currentEpoch) {
  if (_dbsyncIdealDone || _dbsyncIdealInFlight || !_dbsyncBackfillDone) return;
  _dbsyncIdealInFlight = true;
  try {
    const rows = await cacheGetEpochsRaw(0, 9_999_999);
    const need = rows.filter((r) => r.data && r.data.source === 'dbsync'
      && r.data.ideal == null && r.data.activeStakeLovelace
      && r.epoch < currentEpoch);
    if (!need.length) { _dbsyncIdealDone = true; console.log('[dbsync] ideal fill complete'); return; }
    const lo = need[0].epoch, hi = need[need.length - 1].epoch;
    const t0 = performance.now();
    // Two bulk queries cover every epoch at once.
    const [netStakeAll, netBlocks] = await Promise.all([
      dbsync.getNetActiveStakeAll(lo, hi),
      dbsync.getNetBlocks(lo, hi),
    ]);
    let filled = 0;
    for (const r of need) {
      const netStake = netStakeAll[r.epoch];
      const nb = netBlocks[r.epoch];
      if (netStake && nb != null) {
        const sigma = Number(r.data.activeStakeLovelace) / netStake;
        const ideal = Math.round(sigma * nb * 100) / 100;
        await cachePutEpoch(r.epoch, { ...r.data, ideal });
        await cacheMetaSet(`netstake:${r.epoch}`, String(netStake));   // cache for any single-epoch use
        filled++;
      }
    }
    _dbsyncIdealDone = true;
    console.log(`[dbsync] ideal fill: ${filled} epochs in ${Math.round(performance.now() - t0)}ms (2 bulk queries)`);
  } catch (e) {
    console.warn('[dbsync] ideal fill failed:', e.message ?? e);
  } finally {
    _dbsyncIdealInFlight = false;
  }
}

/** History dispatcher — called from the live loop; routes by DATA_SOURCE. */
export async function refreshHistory(currentEpoch) {
  // Koios is the always-available baseline - register it so history and pool
  // parameters resolve even when db-sync is not used.
  const koiosOk = await ensureKoios();
  // db-sync only if the operator opted in (ensureDbsync respects the saved
  // choice). When present it is preferred and backfills the richer history.
  const dbOk = await ensureDbsync();
  if (dbOk) {
    await backfillFromDbsync(currentEpoch);
    dbsyncIdealFiller(currentEpoch);   // fire-and-forget; self-throttled
  } else if (koiosOk) {
    await backfillFromKoios(currentEpoch);
  } else if (await ensureBlockfrost()) {
    await backfillFromBlockfrost(currentEpoch);
  }
}

// ---- Blockfrost history source (optional fallback for Blockfrost-only ops) --
// Pulls the full per-epoch history via the capability registry (Stage-1
// getPoolHistory provider). Paginated /pools/{id}/history is ~4 calls for the
// whole history, then cached - runs once per session.
let _bfBackfillDone = false;
let _bfBackfillInFlight = false;
async function backfillFromBlockfrost(currentEpoch) {
  if (_bfBackfillDone || _bfBackfillInFlight || !currentEpoch) return;
  _bfBackfillInFlight = true;
  try {
    const t0 = performance.now();
    const rows = await registry.get(DataKind.EPOCH_BLOCKS, { from: null, to: currentEpoch });
    if (Array.isArray(rows) && rows.length) {
      for (const r of rows) await cachePutEpoch(r.epoch, r);
      _bfBackfillDone = true;
      console.log(`[blockfrost] backfill: ${rows.length} epochs in ${Math.round(performance.now() - t0)}ms`);
    } else {
      console.warn('[blockfrost] backfill returned no rows');
    }
  } catch (e) {
    console.warn('[blockfrost] backfill failed:', e.message ?? e);
  } finally {
    _bfBackfillInFlight = false;
  }
}

// ---- Koios history source (portable fallback for no-db-sync operators) ----
// The entire backfill is ONE /pool_history call (all epochs), with ideal
// derived locally from active_stake_pct — no per-epoch loop, no ban risk.
let _koiosInit = false;
let _koiosBackfillDone = false;
let _koiosBackfillInFlight = false;

async function ensureKoios() {
  if (!KOIOS_ENABLED) return false;   // master switch: Koios fully off
  if (_koiosInit) return koiosHist.koiosSource.reachable();
  _koiosInit = true;
  const ok = await koiosHist.initKoios(ensurePoolBech32());
  if (ok) await cacheMetaSet('history_source', 'koios');
  return ok;
}

// Optional Blockfrost enrichment (DELEGATORS view). Idempotent; no-op without a
// key. Safe to call on connect and from the DELEGATORS view.
let _blockfrostInit = false;
export async function ensureBlockfrost() {
  if (_blockfrostInit) return blockfrost.blockfrostSource.reachable();
  if (!blockfrost.hasBlockfrostKey()) return false;   // optional — silent without a key
  _blockfrostInit = true;
  return blockfrost.initBlockfrost(ensurePoolBech32());
}

/**
 * Set (or clear) the Blockfrost key from the UI and (re)activate it immediately.
 * Pass a falsy key to remove it. Returns true if Blockfrost is reachable after.
 * Centralises key + re-init so the wizard/settings never touch pool internals.
 */
export async function applyBlockfrostKey(key) {
  blockfrost.setBlockfrostKey(key || '');
  blockfrost.resetBlockfrost();
  _blockfrostInit = false;
  if (!key) return false;
  _blockfrostInit = true;
  try { return await blockfrost.initBlockfrost(ensurePoolBech32()); }
  catch (e) { console.warn('[blockfrost] apply failed:', e.message ?? e); return false; }
}

/** Re-probe the already-configured Blockfrost key (clears the latched init guard
 *  so a failed/incomplete earlier probe can be retried). Returns reachable bool. */
export async function reverifyBlockfrost() {
  if (!blockfrost.hasBlockfrostKey()) return false;
  blockfrost.resetBlockfrost();
  _blockfrostInit = false;
  _blockfrostInit = true;
  try { return await blockfrost.initBlockfrost(ensurePoolBech32()); }
  catch (e) { console.warn('[blockfrost] reverify failed:', e.message ?? e); return false; }
}

/** UI status: is a key configured, and is the source currently reachable? */
export function blockfrostStatus() {
  return {
    configured: blockfrost.hasBlockfrostKey(),
    healthy: (() => { try { return blockfrost.blockfrostSource.reachable(); } catch { return false; } })(),
  };
}

async function backfillFromKoios(currentEpoch) {
  if (_koiosBackfillDone || _koiosBackfillInFlight || !currentEpoch) return;
  _koiosBackfillInFlight = true;
  try {
    if (!(await ensureKoios())) { console.warn('[koios] backfill skipped — not reachable'); return; }
    const t0 = performance.now();
    const rows = await koiosHist.fetchHistory(null, currentEpoch);   // ONE call
    for (const r of rows) await cachePutEpoch(r.epoch, r);
    // Recently-settled epochs are returned with null rewards by Koios until it
    // computes them (a day or so later). Re-fetch the trailing window every run
    // so those null->real transitions overwrite the stale cached nulls.
    try {
      const fromE = Math.max(0, currentEpoch - 12);
      const recent = await koiosHist.fetchHistory(fromE, currentEpoch);
      for (const r of recent) await cachePutEpoch(r.epoch, r);
    } catch (e) { console.warn('[koios] trailing re-fetch failed:', e.message ?? e); }
    _koiosBackfillDone = true;
    console.log(`[koios] backfill: ${rows.length} epochs (1 API call) in ${Math.round(performance.now() - t0)}ms`);
  } catch (e) {
    console.warn('[koios] backfill failed:', e.message ?? e);
  } finally {
    _koiosBackfillInFlight = false;
  }
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
// NOTIFICATIONS — live delegation-change feed (source-agnostic)
// ============================================================
// Polls the LIVE delegator set (~5 min), diffs it against the last snapshot
// held in the local cache, and emits events: join, leave (redelegated vs
// to-wallet), stake up/down. Genuinely intra-epoch live — Koios `amount` is
// live stake, not the epoch_stake snapshot that only moves at boundaries.
//
// The set is fetched THROUGH the capability spine (DELEGATOR_LIST_LIVE); this
// function never names a source, so the setup wizard can later point it at
// Blockfrost or db-sync with zero changes here. Fire-and-forget from the live
// loop, internally throttled, defensive: a source outage keeps the last
// snapshot and emits nothing rather than flooding.

// Poll cadence and stake-change threshold are operator-configurable via the
// notifications settings panel / setup wizard (see notif-settings.js). The
// defaults (5 min, 10 ADA) live there; we read the live values each poll.
const NOTIF_EVENTS_KEEP = 1000;                  // cache retains newest N (pruned Rust-side)

let _notifAt = 0;
let _notifInFlight = false;
let _notifArmed = false;
const _tickerCache = new Map();   // poolBech32 -> ticker|null, session-lived (tickers rarely change)

/** Resolve pool ids to tickers, fetching only the ones we haven't seen this
 *  session. Returns Map(id -> ticker|null). Failures leave the id unresolved
 *  (caller shows the raw id). */
async function resolveTickers(ids) {
  const out = new Map();
  const missing = [];
  for (const id of ids) {
    if (_tickerCache.has(id)) out.set(id, _tickerCache.get(id));
    else missing.push(id);
  }
  if (missing.length) {
    try {
      const fetched = await koios.getPoolTickers(missing);
      for (const id of missing) {
        const t = fetched.has(id) ? fetched.get(id) : null;
        _tickerCache.set(id, t);
        out.set(id, t);
      }
    } catch (e) {
      console.warn('[notif] ticker resolve failed:', e.message ?? e);
    }
  }
  return out;
}

/** Classify departed delegators: where did each go? Returns Map(stake ->
 *  'ours' | poolBech32 | null | 'unknown'). 'ours' = false positive (still with
 *  us → suppress); bech32 = redelegated there; null = no live delegation
 *  (wallet / deregistered); 'unknown' = couldn't determine (emit a generic
 *  leave). One batched lookup for ALL leavers. Koios-specific enrichment for
 *  now; degrades to 'unknown' on any failure so a leave is never lost. */
async function classifyLeavers(stakes) {
  const out = new Map();
  if (!stakes.length) return out;
  try {
    const info = await koios.getAccountsDelegatedPool(stakes);   // Map(stake -> poolBech32|null)
    const ours = ensurePoolBech32();
    for (const s of stakes) {
      if (!info.has(s)) { out.set(s, 'unknown'); continue; }
      const p = info.get(s);
      if (p && ours && p === ours) out.set(s, 'ours');
      else out.set(s, p || null);
    }
  } catch (e) {
    console.warn('[notif] classifyLeavers failed:', e.message ?? e);
    for (const s of stakes) out.set(s, 'unknown');
  }
  return out;
}

/** Live delegation-change poll. Fire-and-forget; safe to call every loop. */
export async function refreshNotifications(currentEpoch) {
  if (_notifInFlight) return;
  const now = Date.now();
  if (_notifAt !== 0 && now - _notifAt < getNotifPollMs()) return;

  // Arm the zero-config default provider (Koios) ONLY if nothing else already
  // provides the live set — when the wizard registers a configured source
  // (Blockfrost / db-sync), this no-ops and we use that instead.
  if (!_notifArmed) {
    _notifArmed = true;
    if (KOIOS_ENABLED && !registry.can(DataKind.DELEGATOR_LIST_LIVE)) {
      koios.initKoiosLiveDelegators(ensurePoolBech32());
    }
  }
  if (!registry.can(DataKind.DELEGATOR_LIST_LIVE)) return;   // no source available yet

  _notifInFlight = true;
  _notifAt = now;
  try {
    const cur = await registry.get(DataKind.DELEGATOR_LIST_LIVE);   // source-agnostic
    if (!Array.isArray(cur) || cur.length === 0) return;   // outage → keep snapshot, emit nothing

    const baseKey = `notif_baseline:${poolHex()}`;
    const wmKey = `notif_deleg_wm2:${poolHex()}`;   // db-sync global delegation.id watermark (joins + leaves)
    const baselined = await cacheMetaGet(baseKey);
    const prevRows = await cacheGetNotifSnapshot();
    const prev = new Map(prevRows.map((r) => [r.stake, r]));

    const lovOf = (d) => d.liveStakeLovelace ?? Math.round((d.liveStake || 0) * 1e6);
    const curRows = cur.map((d) => ({ stake: d.stake, lovelace: lovOf(d), latestDelegTx: d.latestDelegTx ?? null }));

    // First run for this pool → store baseline, emit nothing (no false flood of
    // "joins" for every existing delegator). Re-baselines if the snapshot is
    // somehow empty (cache cleared), so it stays self-healing.
    if (baselined !== 'done' || prev.size === 0) {
      await cachePutNotifSnapshot(curRows);
      await cacheMetaSet(baseKey, 'done');
      // Seed the db-sync join watermark to the current tip so first run doesn't
      // replay every historical join; later polls emit only newer certs.
      if (dbsync.dbsyncSource.reachable()) {
        try { await cacheMetaSet(wmKey, String(await dbsync.getMaxDelegationId())); }
        catch (e) { console.warn('[notif] watermark seed failed:', e.message ?? e); }
      }
      console.log(`[notif] baseline stored (${curRows.length} delegators) — no events emitted`);
      return;
    }

    const curMap = new Map(cur.map((d) => [d.stake, d]));
    const events = [];

    // --- Instant joins from db-sync (when available) -------------------------
    // db-sync records each delegation cert the moment it lands in a block, so
    // joins / redelegations-in are caught intra-epoch — Koios pool_delegators
    // only reflects a new delegator at the epoch boundary. Watermark by
    // delegation.id so each cert emits exactly once. When this is active, the
    // Koios membership-diff join path below is suppressed: every real join is
    // caught here, so there's no double-report and no false "leave" when Koios
    // finally catches up (it's silently absorbed into the snapshot).
    let dbsyncJoinsActive = false;
    if (dbsync.dbsyncSource.reachable()) {
      dbsyncJoinsActive = true;
      try {
        const wmRaw = await cacheMetaGet(wmKey);
        if (wmRaw == null) {
          // No watermark yet (first run / upgraded semantics) — seed to the
          // current tip and emit nothing, so we never replay historical certs.
          try { await cacheMetaSet(wmKey, String(await dbsync.getMaxDelegationId())); }
          catch (e) { console.warn('[notif] watermark seed (mid-run) failed:', e.message ?? e); }
        } else {
          const wm = Number(wmRaw) || 0;
          const { events: devs, scannedMax } = await dbsync.getDelegationEvents({ sinceId: wm, limit: 1000 });
          if (devs.length) {
            // Overlay live balances for everyone involved (the cert carries no
            // amount): a joiner's brought-in stake, a leaver's departing stake.
            let bal = new Map();
            try { bal = await koios.getAccountsBalances(devs.map((d) => d.stake)); }
            catch (e) { console.warn('[notif] event balance overlay failed:', e.message ?? e); }
            for (const d of devs) {
              const detail = {
                amount: bal.has(d.stake) ? bal.get(d.stake) : null,
                epoch: d.epoch ?? null, slot: d.slot ?? null,
                time: d.time ?? null, txHash: d.txHash ?? null,
              };
              if (d.fromPool) { detail.fromPool = d.fromPool; detail.fromTicker = d.fromTicker ?? null; }
              if (d.toPool) { detail.toPool = d.toPool; detail.toTicker = d.toTicker ?? null; }
              events.push({ type: d.type, stake: d.stake, detail });
            }
          }
          if (scannedMax != null && scannedMax > wm) await cacheMetaSet(wmKey, String(scannedMax));
        }
      } catch (e) {
        console.warn('[notif] db-sync event detection failed:', e.message ?? e);
      }
    }

    // Joins (collected, classified below) + stake up/down (walk current set).
    const joins = [];
    for (const d of cur) {
      const before = prev.get(d.stake);
      const lov = lovOf(d);
      if (!before) {
        // New in the Koios set. If db-sync is catching joins, this is just the
        // boundary catch-up of a join already emitted — absorb silently.
        if (!dbsyncJoinsActive) joins.push({ stake: d.stake, amount: lov });
      } else {
        const delta = lov - Number(before.lovelace || 0);
        if (Math.abs(delta) >= getNotifThresholdLovelace()) {
          events.push({ type: delta > 0 ? 'stake_up' : 'stake_down', stake: d.stake,
                        detail: { amount: lov, delta, epoch: currentEpoch ?? null } });
        }
      }
    }

    // Classify joins: brand-new vs redelegated IN from another pool. One batched
    // prior-pool lookup; on failure every joiner degrades to a plain 'join'.
    if (joins.length) {
      let origins = new Map();
      try { origins = await koios.getAccountsPriorPool(joins.map((j) => j.stake), ensurePoolBech32()); }
      catch (e) { console.warn('[notif] join origin lookup failed:', e.message ?? e); }
      for (const j of joins) {
        const from = origins.get(j.stake) || null;
        if (from) {
          events.push({ type: 'join_redelegated', stake: j.stake,
                        detail: { amount: j.amount, fromPool: from, epoch: currentEpoch ?? null } });
        } else {
          events.push({ type: 'join', stake: j.stake, detail: { amount: j.amount, epoch: currentEpoch ?? null } });
        }
      }
    }

    // Leaves (in prev, gone from cur) — classify destination. Skipped when
    // db-sync is active: it already catches redelegations out instantly and
    // richly, and the Koios set only drops a leaver at the epoch boundary
    // (which would double-report and lag).
    const leavers = dbsyncJoinsActive ? [] : prevRows.filter((r) => !curMap.has(r.stake)).map((r) => r.stake);
    if (leavers.length) {
      const dest = await classifyLeavers(leavers);
      for (const stake of leavers) {
        const to = dest.has(stake) ? dest.get(stake) : 'unknown';
        if (to === 'ours') continue;   // false positive — still delegated to us
        const amount = Number(prev.get(stake)?.lovelace || 0);
        if (to === 'unknown') {
          events.push({ type: 'leave', stake, detail: { amount, epoch: currentEpoch ?? null } });
        } else if (to) {
          events.push({ type: 'leave_redelegated', stake, detail: { toPool: to, amount, epoch: currentEpoch ?? null } });
        } else {
          events.push({ type: 'leave_to_wallet', stake, detail: { amount, epoch: currentEpoch ?? null } });
        }
      }
    }

    // Fill any STILL-MISSING tickers via Koios (db-sync joins already carry
    // theirs; this covers Koios-fallback joins and leave destinations).
    const poolIds = new Set();
    for (const e of events) {
      if (e.detail && e.detail.fromPool && e.detail.fromTicker == null) poolIds.add(e.detail.fromPool);
      if (e.detail && e.detail.toPool && e.detail.toTicker == null) poolIds.add(e.detail.toPool);
    }
    if (poolIds.size) {
      const tickers = await resolveTickers([...poolIds]);
      for (const e of events) {
        if (e.detail && e.detail.fromPool && e.detail.fromTicker == null) e.detail.fromTicker = tickers.get(e.detail.fromPool) || null;
        if (e.detail && e.detail.toPool && e.detail.toTicker == null) e.detail.toTicker = tickers.get(e.detail.toPool) || null;
      }
    }

    if (events.length) {
      await cachePutNotifEvents(events);
      const tally = events.reduce((m, e) => (m[e.type] = (m[e.type] || 0) + 1, m), {});
      console.log('[notif] emitted', JSON.stringify(tally));
      // Signal the UI (toast / view badge) — decoupled: we dispatch a window
      // event rather than touching the DOM from the data layer.
      try {
        if (typeof window !== 'undefined' && window.dispatchEvent) {
          window.dispatchEvent(new CustomEvent('pt:notif-events', { detail: events }));
        }
      } catch (e) { /* non-fatal: feed is still persisted */ }
    }
    await cachePutNotifSnapshot(curRows);   // advance the baseline
  } catch (e) {
    console.warn('[notif] refresh failed:', e.message ?? e);
  } finally {
    _notifInFlight = false;
  }
}

/** Newest-first event feed for the NOTIFICATIONS view. */
export async function getNotifications(limit = 200) {
  return cacheGetNotifEvents(limit);
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
  _ubCurEpoch = null; _ubCurSlots = null; _ubNextEpoch = null; _ubNextSlots = null; _ubNextCheckedAt = 0;
  _healthAt = 0;
  _dbsyncInit = false; _dbsyncBackfillDone = false; _dbsyncBackfillInFlight = false;
  _koiosInit = false; _koiosBackfillDone = false; _koiosBackfillInFlight = false;
  _blockfrostInit = false; blockfrost.resetBlockfrost();
  koiosHist.resetKoios();
  _dbsyncIdealDone = false; _dbsyncIdealInFlight = false;
  dbsync.resetDbsync();
  _notifAt = 0; _notifInFlight = false; _notifArmed = false;
  _tickerCache.clear();
  koios.resetKoiosLiveDelegators();
}

// ---- Reward reconciler -----------------------------------------------------
// Koios returns reward fields intermittently null for settled epochs (the data
// exists; the response flickers). For any cached epoch that produced blocks but
// still shows null deleg_rewards, re-query it individually until Koios returns a
// real value, then it is locked in (cachePutEpoch won't let null overwrite it).
let _reconcileInFlight = false;
let _reconcileDone = false;
async function reconcileRewards() {
  if (!KOIOS_ENABLED || _reconcileInFlight || _reconcileDone) return;
  _reconcileInFlight = true;
  try {
    const bech32 = ensurePoolBech32();
    if (!bech32) return;
    const rows = await cacheGetEpochsRaw(0, 9_999_999);
    // Need rewards where the pool produced blocks but the cached pot is null.
    const need = rows.filter((r) => r.data && (r.data.adopted || 0) > 0 && r.data.delegRewards == null)
                     .map((r) => r.epoch)
                     .sort((a, b) => b - a);   // newest first
    const needSet = new Set(need);
    if (!needSet.size) { _reconcileDone = true; console.log('[read-model] reward reconcile: nothing to fix'); return; }
    console.log(`[read-model] reward reconcile: ${needSet.size} epochs need rewards`, need);
    // One full pool_history fetch; write back any needed epoch that now has a
    // real reward. cachePutEpoch guards against null overwriting a real value,
    // so epochs that flicker null on this pass are simply left for next launch.
    let fixed = 0;
    const hist = await koios.getPoolHistory(bech32, { limit: 0 });
    for (const h of (Array.isArray(hist) ? hist : [])) {
      if (needSet.has(h.epoch) && h.delegRewards != null) {
        await cachePutEpoch(h.epoch, historyRow(h));
        fixed++;
      }
    }
    console.log(`[read-model] reward reconcile: fixed ${fixed}/${needSet.size} this pass`);
    if (fixed >= needSet.size) _reconcileDone = true;
  } catch (err) {
    console.warn('[read-model] reward reconcile failed:', err.message ?? err);
  } finally {
    _reconcileInFlight = false;
  }
}

