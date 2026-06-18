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

/** The pool's first epoch with active stake — bounds backfill to its lifetime. */
export async function getPoolFirstEpoch() {
  const rows = await pgQuery(_cfg,
    `SELECT MIN(epoch_no)::text AS e FROM epoch_stake WHERE pool_id = ${_poolId}`);
  return rows.length && rows[0].e ? Number(rows[0].e) : null;
}

/**
 * Current delegator list (all delegators with their active stake this epoch),
 * sorted by stake desc, owner/pledge addresses flagged. One indexed query —
 * ~50ms even for a 4000-delegator pool. Note: this is active stake (epoch
 * boundary), not live; the deep-dive uses Blockfrost for live/movement detail.
 */
export async function getDelegatorList() {
  // Owner (pledge) stake addresses from the latest pool registration cert.
  const owners = new Set();
  try {
    const orows = await pgQuery(_cfg, `
      SELECT sa.view AS stake
      FROM pool_owner po
      JOIN pool_update pu ON pu.id = po.pool_update_id
      JOIN stake_address sa ON sa.id = po.addr_id
      WHERE pu.hash_id = ${_poolId}
      ORDER BY pu.registered_tx_id DESC`);
    (orows || []).forEach((r) => owners.add(r.stake));
  } catch { /* owners are a nice-to-have flag */ }

  const rows = await pgQuery(_cfg, `
    WITH cur AS (SELECT MAX(epoch_no) AS e FROM epoch_stake)
    SELECT sa.view AS stake, es.amount::text AS lovelace
    FROM epoch_stake es
    JOIN stake_address sa ON sa.id = es.addr_id
    WHERE es.epoch_no = (SELECT e FROM cur) AND es.pool_id = ${_poolId}
    ORDER BY es.amount DESC`);
  return (rows || []).map((r) => {
    const lov = Number(r.lovelace);
    return {
      stake: r.stake,
      liveStake: lov / 1_000_000,
      liveStakeLovelace: lov,
      isOwner: owners.has(r.stake),
    };
  });
}

/**
 * Loyalty / tenure for every CURRENT delegator: the length (in epochs) of their
 * current unbroken run with us, plus the epoch that run began. Uses the classic
 * gaps-and-islands technique (epoch_no − ROW_NUMBER() groups consecutive epochs;
 * the group containing the latest epoch is the current run). Whole-pool, one
 * indexed pass — ~130ms here, scales to large pools. Returns rows ordered by
 * tenure desc: { stake, tenure, sinceEpoch }.
 */
export async function getLoyalty() {
  console.log('[dbsync.getLoyalty] issuing query for pool_id', _poolId);
  const _t = Date.now();
  const rows = await pgQuery(_cfg, `
    WITH cur AS (SELECT MAX(epoch_no) AS e FROM epoch_stake),
    delegs AS (SELECT addr_id FROM epoch_stake WHERE epoch_no=(SELECT e FROM cur) AND pool_id=${_poolId}),
    mine AS (
      SELECT es.addr_id, es.epoch_no, es.amount,
             LAG(es.amount) OVER (PARTITION BY es.addr_id ORDER BY es.epoch_no) AS prev_amt
      FROM epoch_stake es WHERE es.pool_id=${_poolId} AND es.addr_id IN (SELECT addr_id FROM delegs)
    ),
    grouped AS (
      SELECT addr_id, epoch_no, amount, prev_amt,
             epoch_no - ROW_NUMBER() OVER (PARTITION BY addr_id ORDER BY epoch_no) AS grp FROM mine
    ),
    latest_grp AS (SELECT addr_id, grp FROM grouped WHERE epoch_no=(SELECT e FROM cur)),
    run AS (
      SELECT g.addr_id, COUNT(*)::int AS tenure, MIN(g.epoch_no)::int AS since_epoch
      FROM grouped g JOIN latest_grp lg ON lg.addr_id=g.addr_id AND lg.grp=g.grp GROUP BY g.addr_id
    ),
    curstake AS (SELECT addr_id, (amount/1000000)::bigint AS cur_ada FROM mine WHERE epoch_no=(SELECT e FROM cur)),
    -- >=50% drops with us (candidates for both reduction & defection)
    big_drops AS (
      SELECT addr_id, epoch_no AS drop_epoch, amount AS new_amt, prev_amt
      FROM mine WHERE prev_amt IS NOT NULL AND amount < prev_amt*0.5
    ),
    -- reduction factor: worst (fraction pulled × recency), halflife ~36 epochs
    reductions AS (
      SELECT addr_id,
             MAX( (1.0 - new_amt::float/NULLIF(prev_amt,0)) * (36.0/(36.0+((SELECT e FROM cur)-drop_epoch))) ) AS worst
      FROM big_drops GROUP BY addr_id
    ),
    -- defection: a >=50% drop where >=50% of the lost stake appeared at another pool within 1 epoch
    defections AS (
      SELECT DISTINCT ON (bd.addr_id) bd.addr_id, bd.drop_epoch, o.pool_id AS to_pool_id,
             (o.amount/1000000)::bigint AS to_ada
      FROM big_drops bd
      JOIN epoch_stake o ON o.addr_id=bd.addr_id AND o.pool_id<>${_poolId}
           AND o.epoch_no BETWEEN bd.drop_epoch AND bd.drop_epoch+1
           AND o.amount >= (bd.prev_amt - bd.new_amt)*0.5
      ORDER BY bd.addr_id, bd.drop_epoch
    )
    SELECT sa.view AS stake, r.tenure, r.since_epoch, c.cur_ada,
           COALESCE(red.worst,0) AS reduction_factor,
           def.drop_epoch AS defect_epoch,
           dph.view AS defect_to_pool,
           def.to_ada AS defect_to_ada
    FROM run r
    JOIN curstake c ON c.addr_id=r.addr_id
    JOIN stake_address sa ON sa.id=r.addr_id
    LEFT JOIN reductions red ON red.addr_id=r.addr_id
    LEFT JOIN defections def ON def.addr_id=r.addr_id
    LEFT JOIN pool_hash dph ON dph.id=def.to_pool_id
    ORDER BY r.tenure DESC`);
  console.log(`[dbsync.getLoyalty] query done: ${(rows||[]).length} rows in ${Date.now()-_t}ms`);
  return (rows || []).map((r) => ({
    stake: r.stake,
    tenure: Number(r.tenure),
    sinceEpoch: Number(r.since_epoch),
    curStake: Number(r.cur_ada),
    reductionFactor: Number(r.reduction_factor) || 0,   // 0..1 (worst recency-weighted pull)
    defected: r.defect_to_pool != null,
    defectToPool: r.defect_to_pool || null,
    defectEpoch: r.defect_epoch != null ? Number(r.defect_epoch) : null,
    defectToAda: r.defect_to_ada != null ? Number(r.defect_to_ada) : null,
  }));
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

/**
 * Network active stake for ALL epochs in ONE pass (GROUP BY). One query over
 * epoch_stake instead of ~400 per-epoch sums — turns ~108s of trickle into a
 * single grouped scan. Returns { epoch_no: netStakeLovelace }. Used to fill the
 * ideal denominator for the whole history at once.
 */
export async function getNetActiveStakeAll(from, to) {
  const f = safeEpoch(from), t = safeEpoch(to);
  const rows = await pgQuery(_cfg,
    `SELECT epoch_no::text AS epoch, SUM(amount)::text AS net
       FROM epoch_stake WHERE epoch_no BETWEEN ${f} AND ${t}
       GROUP BY epoch_no`);
  const m = {};
  for (const r of rows) m[Number(r.epoch)] = numOrNull(r.net);
  return m;
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

/**
 * Live delegation-IN events from db-sync — stake addresses that delegated TO
 * this pool, newest first. Event-sourced off the `delegation` table (one row
 * per cert, present the moment the tx is in a block — instant, unlike Koios
 * pool_delegators which only reflects new members at the epoch boundary).
 *
 * Information-rich: each event carries the pool the delegator came from, plus
 * epoch / slot / block-time / tx hash for an explorer link. Re-delegations to
 * the SAME pool (prev pool == us) are dropped — they aren't new joins.
 *
 * Amount is NOT included here (the `delegation` table doesn't carry balance);
 * the caller overlays live balance from account_info at emit time.
 *
 * @param {object} opts
 * @param {number} [opts.sinceId]  only certs with delegation.id > this (watermark)
 * @param {number} [opts.hours=6]  if no sinceId given, look back this many hours
 * @param {number} [opts.limit=200]
 * @returns {Promise<Array>} [{ delegationId, type, stake, fromPool, epoch, slot, time, txHash }]
 *   type: 'join' (first-ever / no prior pool) | 'join_redelegated' (came from another pool)
 */
export async function getDelegationEvents(opts = {}) {
  if (!_poolId) return { events: [], scannedMax: null };
  const limit = Math.min(Math.max(Number(opts.limit) || 500, 1), 5000);

  let whereWindow;
  let sid = null;
  if (opts.sinceId != null) {
    sid = Number(opts.sinceId);
    if (!Number.isInteger(sid) || sid < 0) throw new Error(`invalid sinceId: ${opts.sinceId}`);
    whereWindow = `d.id > ${sid}`;          // watermark mode (global scan, both directions)
  } else {
    const hours = Math.min(Math.max(Number(opts.hours) || 6, 1), 24 * 30);
    whereWindow = `b.time > now() - interval '${hours} hours'`;
  }

  // Scan recent delegation certs network-wide (capped by LIMIT), resolve each
  // addr's PREVIOUS pool, then keep only certs that touch OUR pool — either as
  // the new target (a join) or as the prior pool (a leave / redelegation out).
  // pool_hash + off_chain_pool_data resolve both sides' bech32 + ticker locally.
  const rows = await pgQuery(_cfg, `
    SELECT e.deleg_id, e.stake, e.epoch_no, e.slot_no, e.block_time, e.tx_hash,
           e.new_pool_id, e.prev_pool_id, e.was_ours,
           phn.view AS new_pool,  ocn.ticker_name AS new_ticker,
           php.view AS prev_pool, ocp.ticker_name AS prev_ticker
    FROM (
      SELECT d.id AS deleg_id, d.addr_id, d.pool_hash_id AS new_pool_id,
             sa.view AS stake,
             b.epoch_no::text AS epoch_no,
             b.slot_no::text  AS slot_no,
             b.time::text     AS block_time,
             encode(tx.hash,'hex') AS tx_hash,
             (SELECT d2.pool_hash_id FROM delegation d2
               WHERE d2.addr_id = d.addr_id AND d2.id < d.id
               ORDER BY d2.id DESC LIMIT 1) AS prev_pool_id,
             (EXISTS (SELECT 1 FROM delegation d3
               WHERE d3.addr_id = d.addr_id AND d3.pool_hash_id = ${_poolId} AND d3.id < d.id))::int AS was_ours
      FROM delegation d
      JOIN stake_address sa ON sa.id = d.addr_id
      JOIN tx ON tx.id = d.tx_id
      JOIN block b ON b.id = tx.block_id
      WHERE ${whereWindow}
      ORDER BY d.id ASC
      LIMIT ${limit}
    ) e
    LEFT JOIN pool_hash phn ON phn.id = e.new_pool_id
    LEFT JOIN pool_hash php ON php.id = e.prev_pool_id
    LEFT JOIN LATERAL (SELECT ticker_name FROM off_chain_pool_data WHERE pool_id = e.new_pool_id  ORDER BY id DESC LIMIT 1) ocn ON true
    LEFT JOIN LATERAL (SELECT ticker_name FROM off_chain_pool_data WHERE pool_id = e.prev_pool_id ORDER BY id DESC LIMIT 1) ocp ON true
    WHERE e.new_pool_id = ${_poolId} OR e.prev_pool_id = ${_poolId}
    ORDER BY e.deleg_id ASC`);

  const events = [];
  for (const r of (rows || [])) {
    const newId = r.new_pool_id != null ? Number(r.new_pool_id) : null;
    const prevId = r.prev_pool_id != null ? Number(r.prev_pool_id) : null;
    const base = {
      delegationId: Number(r.deleg_id), stake: r.stake,
      epoch: numOrNull(r.epoch_no), slot: numOrNull(r.slot_no),
      time: r.block_time, txHash: r.tx_hash,
    };
    if (newId === _poolId && prevId !== _poolId) {
      // Joined us. Returning if they were ever ours before; otherwise a transfer
      // in from another pool, or a brand-new first-ever delegation.
      const wasOurs = Number(r.was_ours) === 1 || r.was_ours === true || r.was_ours === 't' || r.was_ours === 'true';
      const type = wasOurs ? 'join_returning' : (prevId != null ? 'join_redelegated' : 'join');
      events.push({ ...base, type,
                    fromPool: r.prev_pool || null, fromTicker: r.prev_ticker || null });
    } else if (prevId === _poolId && newId !== _poolId) {
      // Left us — redelegated to another pool.
      events.push({ ...base, type: 'leave_redelegated',
                    toPool: r.new_pool || null, toTicker: r.new_ticker || null });
    }
    // both === us (re-stake to same pool) or neither → ignore
  }

  // Advance-watermark target: the highest delegation.id we actually SCANNED in
  // this window (not just matched), so a poll with no matches still advances.
  let scannedMax = null;
  if (sid != null) {
    const mrows = await pgQuery(_cfg,
      `SELECT MAX(id)::text AS m FROM (SELECT id FROM delegation WHERE id > ${sid} ORDER BY id ASC LIMIT ${limit}) s`);
    scannedMax = (mrows.length && mrows[0].m != null) ? Number(mrows[0].m) : null;
  }
  return { events, scannedMax };
}

/**
 * Highest delegation.id pointing at this pool right now — used to seed the
 * notifications watermark on first run so we don't replay historical joins.
 */
export async function getMaxDelegationId() {
  const rows = await pgQuery(_cfg, `SELECT MAX(id)::text AS m FROM delegation`);
  return (rows.length && rows[0].m != null) ? Number(rows[0].m) : 0;
}

const PROVIDES = [
  DataKind.EPOCH_BLOCKS, DataKind.EPOCH_STAKE, DataKind.EPOCH_DELEGATORS,
  DataKind.EPOCH_REWARDS, DataKind.EPOCH_IDEAL, DataKind.POOL_PARAMS,
  DataKind.DELEGATOR_LOYALTY, DataKind.DELEGATOR_LIST, DataKind.DELEGATOR_DETAIL,
];

let _ourBech32 = null;
async function getOurBech32() {
  if (_ourBech32) return _ourBech32;
  try {
    const r = await pgQuery(_cfg, `SELECT view AS v FROM pool_hash WHERE id = ${_poolId}`);
    _ourBech32 = r.length ? r[0].v : null;
  } catch { _ourBech32 = null; }
  return _ourBech32;
}

/**
 * DELEGATOR_DETAIL - one-delegator deep-dive, same shape as the Blockfrost
 * provider so the modal is source-agnostic. db-sync is local/instant, so this
 * queries live each open (no API budget to protect). `balance` here is the
 * delegator's active stake at the latest epoch snapshot (db-sync's authoritative
 * figure); rewards/withdrawals are exact from the reward/withdrawal tables.
 */
async function getDelegatorDetail(stake, _currentEpoch) {
  if (!_ready || !stake) return null;
  const esc = String(stake).replace(/'/g, "''");

  // Per-epoch stake history across ALL pools (oldest first) -> pool-movement runs.
  const hist = await pgQuery(_cfg, `
    SELECT es.epoch_no::text AS epoch, ph.view AS pool, es.amount::text AS amount
    FROM epoch_stake es
    JOIN stake_address sa ON sa.id = es.addr_id
    JOIN pool_hash ph ON ph.id = es.pool_id
    WHERE sa.view = '${esc}'
    ORDER BY es.epoch_no ASC`);

  // Account totals: rewards earned, withdrawals, first active epoch.
  let rewards = null, withdrawals = null, sinceEpoch = null;
  try {
    const a = await pgQuery(_cfg, `
      WITH a AS (SELECT id FROM stake_address WHERE view = '${esc}')
      SELECT
        (SELECT COALESCE(SUM(amount),0) FROM reward WHERE addr_id = (SELECT id FROM a))::text AS rewards,
        (SELECT COALESCE(SUM(amount),0) FROM withdrawal WHERE addr_id = (SELECT id FROM a))::text AS withdrawals,
        (SELECT MIN(epoch_no) FROM epoch_stake WHERE addr_id = (SELECT id FROM a))::text AS since`);
    if (a.length) { rewards = a[0].rewards; withdrawals = a[0].withdrawals; sinceEpoch = numOrNull(a[0].since); }
  } catch (e) { console.warn('[dbsync] detail account query failed:', e.message ?? e); }

  // DRep vote delegation (Conway) - defensive: table may be absent on older schema.
  let drepId = null;
  try {
    const d = await pgQuery(_cfg, `
      SELECT dh.view AS drep
      FROM delegation_vote dv
      JOIN drep_hash dh ON dh.id = dv.drep_hash_id
      WHERE dv.addr_id = (SELECT id FROM stake_address WHERE view = '${esc}')
      ORDER BY dv.id DESC LIMIT 1`);
    if (d.length) drepId = d[0].drep;
  } catch { drepId = null; }

  // Group contiguous same-pool epochs into runs (identical logic to Blockfrost).
  const runs = [];
  for (const row of hist) {
    const last = runs[runs.length - 1];
    if (last && last.poolId === row.pool) {
      last.exitEpoch = Number(row.epoch);
      last.exitStake = lovelaceToAda(row.amount);
    } else {
      runs.push({
        poolId: row.pool,
        entryEpoch: Number(row.epoch), entryStake: lovelaceToAda(row.amount),
        exitEpoch: Number(row.epoch), exitStake: lovelaceToAda(row.amount),
      });
    }
  }
  if (runs.length) runs[runs.length - 1].isCurrent = true;

  const ourB = await getOurBech32();
  let cameFrom = null;
  const firstUsIdx = runs.findIndex((r) => r.poolId === ourB);
  if (firstUsIdx > 0) cameFrom = runs[firstUsIdx - 1].poolId;

  const lastRow = hist.length ? hist[hist.length - 1] : null;
  const rewardsSum = lovelaceToAda(rewards);
  const withdrawalsSum = lovelaceToAda(withdrawals);

  return {
    stake,
    balance: lastRow ? lovelaceToAda(lastRow.amount) : null,   // active stake @ latest snapshot
    rewardsSum,
    withdrawalsSum,
    withdrawable: (rewardsSum != null && withdrawalsSum != null) ? (rewardsSum - withdrawalsSum) : null,
    sinceEpoch,
    drepId,
    currentPool: lastRow ? lastRow.pool : null,
    cameFrom,
    runs,
  };
}

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
      case DataKind.DELEGATOR_LOYALTY:
        return getLoyalty();
      case DataKind.DELEGATOR_LIST:
        return getDelegatorList();
      case DataKind.DELEGATOR_DETAIL:
        return getDelegatorDetail(params.stake, params.currentEpoch);
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
