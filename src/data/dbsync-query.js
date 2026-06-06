/**
 * PoolTerminal — db-sync source (architecture note §5, §12).
 *
 * Reads chain-wide historical data from a local or remote db-sync via the
 * Postgres transport. Emits the canonical epoch-row shape the read-model/HISTORY
 * already consume, so swapping db-sync in for Koios needs no view changes.
 *
 * Universal by construction: zero GNP1/box-specific constants. The pool is
 * resolved at runtime from the node's POOL_ID hex; the connection comes from
 * user config. Validated against db-sync schema 15.44.6.
 *
 * CONTRACT: every selected column is cast ::text (transport requirement — big
 * numeric domains exceed i64/f64). Values arrive as strings; we cast here.
 *
 * SCHEMA DEPENDENCIES (re-validate on db-sync upgrade — see architecture §12):
 *   pool_hash, slot_leader, block, epoch_stake, reward, pool_update, epoch,
 *   schema_version. Highest risk on upgrade: `reward` (type split) and
 *   `epoch_stake` (restructuring).
 */

import { DataKind, registry } from './capabilities.js';
import { pgQuery, pgReachable } from './pg-transport.js';

export const DBSYNC_TESTED_SCHEMA = '15.44.6';

const lovelaceToAda = (v) => (v == null ? null : Number(v) / 1e6);
const numOrNull = (v) => (v == null ? null : Number(v));

// Strict sanitisation — values are inlined into SQL (the transport runs
// parameterless), so guard hard even though they're app-sourced, not user text.
function safeHex(hex) {
  if (typeof hex !== 'string' || !/^[0-9a-f]{56}$/.test(hex)) {
    throw new Error(`invalid pool hex: ${hex}`);
  }
  return hex;
}
function safeEpoch(n) {
  const i = Number(n);
  if (!Number.isInteger(i) || i < 0 || i > 1_000_000) throw new Error(`invalid epoch: ${n}`);
  return i;
}

// ---- module state ----------------------------------------------------------
let _cfg = null;          // { database, host?, port?, user?, password? }
let _poolHex = null;
let _poolId = null;       // resolved pool_hash.id
let _version = null;      // schema version string, e.g. "15.44.6"
let _ready = false;       // reachability + resolved pool, for registry.reachable()

// ---- queries (all columns ::text) ------------------------------------------

async function resolvePoolId() {
  const hex = safeHex(_poolHex);
  const rows = await pgQuery(_cfg,
    `SELECT id::text AS id FROM pool_hash WHERE hash_raw = decode('${hex}','hex')`);
  return rows.length ? Number(rows[0].id) : null;
}

async function readVersion() {
  const rows = await pgQuery(_cfg,
    `SELECT stage_one::text AS a, stage_two::text AS b, stage_three::text AS c FROM schema_version`);
  if (!rows.length) return null;
  return `${rows[0].a}.${rows[0].b}.${rows[0].c}`;
}

/** Blocks per epoch, zero-safe (zero-block epochs return 0, not missing). */
async function qBlocks(from, to) {
  const f = safeEpoch(from), t = safeEpoch(to);
  return pgQuery(_cfg, `
    WITH erange AS (SELECT generate_series(${f},${t}) AS epoch_no)
    SELECT e.epoch_no::text AS epoch, COUNT(b.id)::text AS blocks
    FROM erange e
    LEFT JOIN block b ON b.epoch_no = e.epoch_no
      AND b.slot_leader_id IN (SELECT id FROM slot_leader WHERE pool_hash_id = ${_poolId})
    GROUP BY e.epoch_no ORDER BY e.epoch_no`);
}

/** Pool's active stake + delegator count per epoch (our-pool rows only — fast). */
async function qStake(from, to) {
  const f = safeEpoch(from), t = safeEpoch(to);
  return pgQuery(_cfg, `
    SELECT es.epoch_no::text AS epoch,
           COUNT(DISTINCT es.addr_id)::text AS delegators,
           SUM(es.amount)::text AS stake
    FROM epoch_stake es
    WHERE es.pool_id = ${_poolId} AND es.epoch_no BETWEEN ${f} AND ${t}
    GROUP BY es.epoch_no`);
}

/** Member + leader rewards per epoch (the 5-way split inputs). */
async function qRewards(from, to) {
  const f = safeEpoch(from), t = safeEpoch(to);
  return pgQuery(_cfg, `
    SELECT r.earned_epoch::text AS epoch, r.type::text AS type, SUM(r.amount)::text AS total
    FROM reward r
    WHERE r.pool_id = ${_poolId} AND r.earned_epoch BETWEEN ${f} AND ${t}
    GROUP BY r.earned_epoch, r.type`);
}

/** All pool-param updates (margin/fixed_cost/pledge) ordered by active epoch. */
async function qParams() {
  return pgQuery(_cfg, `
    SELECT active_epoch_no::text AS epoch, margin::text AS margin,
           fixed_cost::text AS fixed_cost, pledge::text AS pledge
    FROM pool_update WHERE hash_id = ${_poolId} ORDER BY active_epoch_no`);
}

/** Network blocks per epoch (cheap, precomputed) — the ideal multiplier. */
export async function getNetBlocks(from, to) {
  const f = safeEpoch(from), t = safeEpoch(to);
  const rows = await pgQuery(_cfg,
    `SELECT no::text AS epoch, blk_count::text AS blocks FROM epoch WHERE no BETWEEN ${f} AND ${t}`);
  const m = {};
  for (const r of rows) m[Number(r.epoch)] = numOrNull(r.blocks);
  return m;
}

/**
 * Network active stake for ONE epoch (the ideal denominator). ~270ms — heavy
 * because it sums all delegation. The read-model caches each result once in
 * poolterminal.db and never recomputes history (architecture §10/§12).
 */
export async function getNetActiveStake(epoch) {
  const e = safeEpoch(epoch);
  const rows = await pgQuery(_cfg,
    `SELECT SUM(amount)::text AS net FROM epoch_stake WHERE epoch_no = ${e}`);
  return rows.length ? numOrNull(rows[0].net) : null;
}

// ---- assembly: canonical epoch rows ----------------------------------------

/** Pick the pool params active at `epoch` from the ordered updates list. */
function paramsAt(epoch, updates) {
  let chosen = null;
  for (const u of updates) { if (Number(u.epoch) <= epoch) chosen = u; else break; }
  return chosen;
}

/**
 * Build canonical rows for [from,to] by merging blocks + stake + rewards +
 * params. `ideal` is left null here — it needs the cached network-stake
 * denominator, which the read-model supplies (cache-once). Same row shape as
 * the Koios path so HISTORY/read-model consume it unchanged.
 */
export async function fetchHistory(from, to) {
  if (!_ready) throw new Error('db-sync source not ready');
  const [blocks, stake, rewards, updates] = await Promise.all([
    qBlocks(from, to), qStake(from, to), qRewards(from, to), qParams(),
  ]);

  const byEpoch = new Map();
  const row = (e) => {
    if (!byEpoch.has(e)) byEpoch.set(e, {
      epoch: e, adopted: null, confirmed: null, delegators: null,
      activeStake: null, activeStakeLovelace: null,
      memberRewards: null, leaderReward: null, delegRewards: null,
      margin: null, fixedCost: null, ideal: null, saturation: null, ros: null,
      leader: null, lost: null, source: 'dbsync',
    });
    return byEpoch.get(e);
  };

  for (const b of blocks) { const r = row(Number(b.epoch)); r.adopted = numOrNull(b.blocks); r.confirmed = r.adopted; }
  for (const s of stake) {
    const r = row(Number(s.epoch));
    r.delegators = numOrNull(s.delegators);
    r.activeStakeLovelace = numOrNull(s.stake);
    r.activeStake = lovelaceToAda(s.stake);
  }
  for (const rw of rewards) {
    const r = row(Number(rw.epoch));
    if (rw.type === 'member') r.memberRewards = lovelaceToAda(rw.total);
    else if (rw.type === 'leader') r.leaderReward = lovelaceToAda(rw.total);
  }
  // Params active at each epoch (margin as fraction, fixed_cost as ADA).
  for (const r of byEpoch.values()) {
    const p = paramsAt(r.epoch, updates);
    if (p) { r.margin = numOrNull(p.margin); r.fixedCost = lovelaceToAda(p.fixed_cost); }

    // Reward completeness (validated against db-sync write order: member rows
    // land before leader rows; a block-producing epoch ALWAYS gets a leader row
    // once calculation finishes — at minimum the fixed fee).
    //   • 0 blocks            → earned nothing → rewards are a finalised 0
    //   • leader+member both  → complete → show the 5-way split
    //   • blocks but no leader → db-sync still calculating → PENDING (show —)
    const hasLeader = r.leaderReward != null;
    const hasMember = r.memberRewards != null;
    if (r.adopted === 0) {
      r.rewardsState = 'zero';                 // finalised zero
      r.memberRewards = 0; r.leaderReward = 0; // explicit 0, not null
    } else if (hasLeader && hasMember) {
      r.rewardsState = 'complete';
    } else {
      r.rewardsState = 'pending';              // calculating — UI shows —
      r.memberRewards = null; r.leaderReward = null;   // don't show a half-split
    }
  }
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
}

// ---- source object + lifecycle ---------------------------------------------

const PROVIDES = [
  DataKind.EPOCH_BLOCKS, DataKind.EPOCH_STAKE, DataKind.EPOCH_DELEGATORS,
  DataKind.EPOCH_REWARDS, DataKind.EPOCH_IDEAL, DataKind.POOL_PARAMS,
];

export const dbsyncSource = {
  id: 'dbsync',
  label: 'db-sync',
  isCli: false,
  provides: () => (_ready ? PROVIDES : []),
  reachable: () => _ready,
  version: () => _version,
  get: async (kind, params = {}) => {
    switch (kind) {
      case DataKind.EPOCH_BLOCKS:
      case DataKind.EPOCH_STAKE:
      case DataKind.EPOCH_DELEGATORS:
      case DataKind.EPOCH_REWARDS:
      case DataKind.POOL_PARAMS:
        return fetchHistory(params.from, params.to);
      default:
        throw new Error(`db-sync source can't provide ${kind}`);
    }
  },
  // Schema-drift signal for the HISTORY header.
  schemaTested: DBSYNC_TESTED_SCHEMA,
  schemaCurrent: () => _version,
  schemaStale: () => _version != null && _version !== DBSYNC_TESTED_SCHEMA,
};

/**
 * Configure + probe db-sync, resolve the pool id, read schema version, and
 * register into the capability spine. Returns true if reachable & resolved.
 * Called by the read-model/main when the user has db-sync enabled.
 */
export async function initDbsync(config, poolHex) {
  _cfg = config;
  _poolHex = poolHex;
  _ready = false; _poolId = null; _version = null;
  try {
    if (!(await pgReachable(_cfg))) { console.warn('[dbsync] not reachable'); return false; }
    _poolId = await resolvePoolId();
    if (!_poolId) { console.warn('[dbsync] pool not found in db-sync'); return false; }
    _version = await readVersion();
    _ready = true;
    if (!registry.all().some((s) => s.id === 'dbsync')) registry.register(dbsyncSource);
    console.log(`[dbsync] ready — pool id ${_poolId}, schema ${_version}` +
      (dbsyncSource.schemaStale() ? ` (tested ${DBSYNC_TESTED_SCHEMA} — verify)` : ''));
    return true;
  } catch (err) {
    console.warn('[dbsync] init failed:', err.message ?? err);
    _ready = false;
    return false;
  }
}

export function resetDbsync() { _cfg = null; _poolHex = null; _poolId = null; _version = null; _ready = false; }
