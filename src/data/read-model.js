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

let _backfillInFlight = false;
let _backfillDone = false;

export async function backfillIfNeeded() {
  if (_backfillDone || _backfillInFlight) return;
  _backfillInFlight = true;
  try {
    if ((await cacheMetaGet('backfill_done')) === '1') { _backfillDone = true; return; }
    const bech32 = ensurePoolBech32();
    if (!bech32) return;

    const hist = await koios.getPoolHistory(bech32, { limit: 0 });
    if (!hist.length) return;

    for (const h of hist) {
      await cachePutEpoch(h.epoch, {
        epoch:         h.epoch,
        activeStake:   h.activeStake,
        delegators:    h.delegators,
        adopted:       h.blockCount,
        confirmed:     h.blockCount,
        ideal:         h.ideal,
        saturation:    h.saturation,
        ros:           h.ros,
        delegRewards:  h.delegRewards,
        memberRewards: h.memberRewards,
        leader:        null,   // assignment unknown for past epochs (forward-only)
        lost:          null,
        source:        'koios_history',
      });
    }
    await cacheMetaSet('backfill_done', '1');
    await cacheMetaSet('backfill_high_epoch', String(Math.max(...hist.map((h) => h.epoch))));
    _backfillDone = true;
    console.log(`[read-model] backfilled ${hist.length} epochs from Koios`);
  } catch (err) {
    console.warn('[read-model] backfill failed:', err.message ?? err);
  } finally {
    _backfillInFlight = false;
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
    // Assignment: once per epoch (leadership-schedule is heavy).
    if (_bpScheduleEpoch !== epoch) {
      _bpScheduleEpoch = epoch;
      _bpAssigned = await leadershipScheduleCurrent();
    }
    // Produced: refresh periodically (blocks can appear mid-epoch).
    const now = Date.now();
    if (_bpProducedAt === 0 || now - _bpProducedAt > PRODUCED_REFRESH_MS) {
      _bpProducedAt = now;
      const bech32 = ensurePoolBech32();
      _bpProduced = bech32 ? await koios.getEpochBlockCount(bech32, epoch) : 0;
    }

    const leaderKnown = _bpAssigned != null;
    const leader = leaderKnown ? _bpAssigned.length : 0;
    const adopted = _bpProduced;
    const lost = leaderKnown ? Math.max(0, leader - adopted) : 0;
    const luckPercent = ideal && ideal > 0 ? Math.round((adopted / ideal) * 100) : 0;

    _bp = { leader, ideal: ideal ?? 0, adopted, confirmed: adopted, lost, luckPercent, leaderKnown };

    await cachePutEpoch(epoch, {
      epoch, leader: leaderKnown ? leader : null, ideal: ideal ?? null,
      adopted, confirmed: adopted, lost: leaderKnown ? lost : null,
      luck: luckPercent, source: 'live',
    });
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

/** Time-series samples for a metric since a unix timestamp. */
export async function getSamples(metric, sinceTs) {
  const rows = await cacheGetSamplesRaw(metric, sinceTs);
  return rows.map((r) => ({ t: r.captured_at, v: r.value }));
}

// ============================================================
// Lifecycle
// ============================================================

/** Reset all module state — call on connect / mode switch / reconnect. */
export function resetReadModel() {
  _bech32 = null;
  _backfillInFlight = false; _backfillDone = false;
  _sampleAt = 0; _sampleInFlight = false; _lastInfo = null;
  _bp = null; _bpInFlight = false; _bpScheduleEpoch = null; _bpAssigned = null;
  _bpProducedAt = 0; _bpProduced = 0;
}
