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

/* Split a per-epoch active-stake series at the chain tip. next-epoch-snap-v80
 *
 * Every source labels a stake snapshot with the epoch it becomes ACTIVE in, and
 * that snapshot is fixed one epoch ahead of the tip: the snapshot taken at the
 * N-1/N boundary is the active stake for epoch N+1. So mid-epoch-N the newest
 * row a source can serve is N+1 — real, already-determined data for an epoch
 * that has not started. Callers must therefore never treat "newest row" as
 * "active now"; take `current` for that, and present `next` as the future
 * figure it is.
 *
 * `rows` oldest→newest, each { epoch, ... }. With no currentEpoch (source that
 * can't tell us the tip) we degrade to the old behaviour: newest row wins.
 */
function splitAtTip(rows, currentEpoch) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) return { current: null, next: null, tip: null };
  let tip = numOrNull(currentEpoch);
  if (tip == null) return { current: list[list.length - 1], next: null, tip: null };
  // Our tip comes from the epoch cache and can lag a boundary by a refresh.
  // A snapshot is only ever one epoch ahead of the chain, so a row further ahead
  // than that means the tip is stale, not the data — advance it.
  const newest = numOrNull(list[list.length - 1].epoch);
  if (newest != null && newest - 1 > tip) tip = newest - 1;
  let current = null, next = null;
  for (const r of list) {
    const ep = numOrNull(r && r.epoch);
    if (ep == null) continue;
    if (ep <= tip) current = r;
    else if (!next || numOrNull(next.epoch) > ep) next = r;   // first future row
  }
  return { current, next, tip };
}

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
 * Full lifetime block history for the pool from db-sync — every block this pool
 * ever forged that made it on-chain, oldest-recorded to newest. Unlike the local
 * CNCLI blocklog (recent, with confirmed/ghosted/stolen fate), db-sync holds the
 * COMPLETE record back to the pool's first block, but only for blocks that made
 * the chain (a ghosted/stolen block never appears here, by definition).
 */
export async function getBlockHistory(limit) {
  if (!_poolId) return [];
  const lim = Math.max(1, Math.min(100000, Number(limit) || 100000));
  const rows = await pgQuery(_cfg, `
    SELECT b.epoch_no::text        AS epoch,
           b.epoch_slot_no::text   AS slot_in_epoch,
           b.block_no::text        AS block,
           to_char(b.time,'YYYY-MM-DD"T"HH24:MI:SS"+00:00"') AS at,
           b.size::text            AS size,
           substr(encode(b.hash,'hex'),1,12) AS hash
    FROM block b
    WHERE b.slot_leader_id IN (SELECT id FROM slot_leader WHERE pool_hash_id = ${_poolId})
    ORDER BY b.block_no DESC
    LIMIT ${lim}`);
  return rows.map((r) => ({
    epoch: Number(r.epoch),
    slotInEpoch: Number(r.slot_in_epoch),
    block: Number(r.block),
    at: r.at,
    size: Number(r.size),
    hash: r.hash,
    status: 'onchain',   // db-sync only holds blocks that made the chain
  }));
}

/**
 * Resolve a set of block HEIGHTS to their producer — bech32 pool id, ticker (from
 * db-sync's local off_chain_pool_data) and full hash. Used to enrich the slow-block
 * propagation log so an operator can see WHICH pool forged a block that reached
 * their node late. Blocks minted by a non-pool slot leader (OBFT / genesis) have a
 * null pool_hash_id and come back with pool_id null, which the caller shows as "—".
 * Not pool-scoped: any block on the chain, not just this pool's. One indexed IN().
 */
export async function getBlockProducers(heights) {
  if (!_cfg || !Array.isArray(heights) || !heights.length) return [];
  const list = [...new Set(heights.map((h) => Number(h))
    .filter((h) => Number.isInteger(h) && h >= 0 && h < 1_000_000_000))].slice(0, 500);
  if (!list.length) return [];
  const rows = await pgQuery(_cfg, `
    SELECT b.block_no::text            AS block,
           encode(b.hash,'hex')        AS hash,
           ph.view                     AS pool_id,
           ocpd.ticker_name            AS ticker
    FROM block b
    LEFT JOIN slot_leader sl ON sl.id = b.slot_leader_id
    LEFT JOIN pool_hash ph   ON ph.id = sl.pool_hash_id
    LEFT JOIN LATERAL (
      SELECT ticker_name FROM off_chain_pool_data
      WHERE pool_id = ph.id ORDER BY id DESC LIMIT 1
    ) ocpd ON true
    WHERE b.block_no IN (${list.join(',')})`);
  return rows.map((r) => ({
    block: Number(r.block),
    hash: r.hash || null,
    poolId: r.pool_id || null,
    ticker: r.ticker || null,
  }));
}

/**
 * CONFIDENT-ONLY producer resolution for slow-block records that predate height
 * capture. `targets` is [{ idx, t }] where t is the block's estimated slot time
 * (UTC epoch seconds = capture time − propagation delay). For each target it
 * looks in a tight ±~10-slot window and returns a match ONLY when that window
 * holds EXACTLY ONE block — so an isolated slow block resolves correctly, while a
 * cluster of blocks close in time (where a nearest-match would mis-attribute, as
 * it once did with NORTH→WAV1) returns nothing and the caller leaves it blank.
 *
 * Matching runs on block.slot_no (a core db-sync index). Wall-clock seconds map
 * to a slot number off a live anchor block read from db-sync itself — no genesis
 * constants, any network.
 *
 * HARDFORK: assumes 1 slot = 1 second (true from Shelley on; these records are
 * always recent, so the linear map holds).
 */
export async function getBlockProducersByTimeConfident(targets) {
  if (!_cfg || !Array.isArray(targets) || !targets.length) return [];
  const rows0 = targets
    .map((x) => ({ idx: Number(x.idx), t: Math.floor(Number(x.t)) }))
    .filter((x) => Number.isInteger(x.idx) && Number.isFinite(x.t) && x.t > 1_500_000_000 && x.t < 5_000_000_000)
    .slice(0, 200);
  if (!rows0.length) return [];
  const values = rows0.map((x) => `(${x.idx}, ${x.t}::bigint)`).join(',');
  // Window is asymmetric: our estimate can only be LATER than the true slot (it
  // ignores the metric-scrape lag), so look further back than forward.
  const rows = await pgQuery(_cfg, `
    WITH anchor AS (
      SELECT bl.slot_no AS s, extract(epoch FROM (bl.time AT TIME ZONE 'UTC'))::bigint AS e
      FROM block bl WHERE bl.slot_no IS NOT NULL ORDER BY bl.id DESC LIMIT 1
    ),
    targets(idx, tsec) AS (VALUES ${values}),
    cand AS (
      SELECT tg.idx AS idx, b.block_no AS block_no, b.hash AS hash, b.slot_leader_id AS slid
      FROM targets tg
      CROSS JOIN anchor a
      JOIN block b
        ON b.slot_no BETWEEN (a.s + (tg.tsec - a.e) - 8) AND (a.s + (tg.tsec - a.e) + 1)
    ),
    uniq AS (SELECT idx FROM cand GROUP BY idx HAVING count(*) = 1)
    SELECT c.idx::text            AS idx,
           c.block_no::text       AS block,
           encode(c.hash,'hex')   AS hash,
           ph.view                AS pool_id,
           ocpd.ticker_name       AS ticker
    FROM cand c
    JOIN uniq u ON u.idx = c.idx
    LEFT JOIN slot_leader sl ON sl.id = c.slid
    LEFT JOIN pool_hash ph   ON ph.id = sl.pool_hash_id
    LEFT JOIN LATERAL (
      SELECT ticker_name FROM off_chain_pool_data
      WHERE pool_id = ph.id ORDER BY id DESC LIMIT 1
    ) ocpd ON true`);
  return rows.map((r) => ({
    idx: Number(r.idx),
    block: r.block != null ? Number(r.block) : null,
    hash: r.hash || null,
    poolId: r.pool_id || null,
    ticker: r.ticker || null,
  }));
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
    WITH cur AS (SELECT MAX(epoch_no) AS e FROM epoch_stake_progress WHERE completed)   /* newest COMPLETE snapshot, not the future one db-sync pre-fills /*dbsync-epoch-complete-v58*/ */
    SELECT sa.view AS stake, es.amount::text AS lovelace, es.epoch_no::text AS epoch
    FROM epoch_stake es
    JOIN stake_address sa ON sa.id = es.addr_id
    WHERE es.epoch_no = (SELECT e FROM cur) AND es.pool_id = ${_poolId}
    ORDER BY es.amount DESC`);
  // NOTE the basis: this is ACTIVE STAKE at the newest complete epoch snapshot,
  // not live stake. Koios/Blockfrost serve this same kind from live figures, so
  // the rows carry `stakeBasis` and the table labels the column accordingly —
  // otherwise a db-sync install reads a little under an explorer and looks wrong.
  // Live stake per account needs a UTxO anti-join (~50ms each, ~6s pool-wide), so
  // it stays on-demand in the per-delegator modal. /*acct-live-v79*/
  return (rows || []).map((r) => {
    const lov = Number(r.lovelace);
    return {
      stake: r.stake,
      liveStake: lov / 1_000_000,
      liveStakeLovelace: lov,
      isOwner: owners.has(r.stake),
      stakeBasis: 'snapshot',
      basisEpoch: numOrNull(r.epoch),
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
    WITH cur AS (SELECT MAX(epoch_no) AS e FROM epoch_stake_progress WHERE completed),
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

/**
 * Reward lovelace credited to each CURRENT delegator at the boundary into
 * `epoch` — i.e. rows that become spendable in that epoch, from both `reward`
 * and `reward_rest`.
 *
 * This is the expected size of every delegator's live-stake jump at the roll.
 * The notifications poller subtracts it so the boundary shift stays quiet
 * WITHOUT having to blind itself for 20 minutes — which is what used to swallow
 * an operator's fee-return payout when it landed inside that window.
 * notif-reward-net-v80
 *
 * One query per epoch (~0.5s here, cached by the caller). Returns
 * Map(stakeAddr -> lovelace); empty map if db-sync hasn't computed the epoch's
 * rewards yet, which the caller treats as "not ready" rather than "no rewards".
 */
export async function getEpochRewardCredits(epoch) {
  const ep = safeEpoch(epoch);
  const out = new Map();
  if (!_ready || !_poolId) return out;
  const sql = (withRest) => `
    WITH cur AS (SELECT MAX(epoch_no) AS e FROM epoch_stake_progress WHERE completed),
    d AS (SELECT addr_id FROM epoch_stake WHERE epoch_no = (SELECT e FROM cur) AND pool_id = ${_poolId})
    SELECT sa.view AS stake, SUM(x.amount)::text AS amount FROM (
      SELECT r.addr_id, r.amount FROM reward r JOIN d ON d.addr_id = r.addr_id WHERE r.spendable_epoch = ${ep}
      ${withRest ? `UNION ALL
      SELECT rr.addr_id, rr.amount FROM reward_rest rr JOIN d ON d.addr_id = rr.addr_id WHERE rr.spendable_epoch = ${ep}` : ''}
    ) x JOIN stake_address sa ON sa.id = x.addr_id
    GROUP BY sa.view`;
  let rows = null;
  for (const withRest of [true, false]) {          // reward_rest is schema 13.2+
    try { rows = await pgQuery(_cfg, sql(withRest)); break; }
    catch (e) { console.warn('[dbsync] epoch reward credits failed:', e.message ?? e); }
  }
  for (const r of (rows || [])) {
    const v = Number(r.amount);
    if (r.stake && Number.isFinite(v) && v > 0) out.set(r.stake, v);
  }
  return out;
}

// --- On-chain message feed (CIP-20 tx metadata, label 674) ------------------
// Watermarked by tx_metadata.id so each message surfaces exactly once. Returns
// the raw text (msg array joined by newlines / string as-is); the DEX-bot
// denylist and profanity filtering are applied in the UI so its toggles work
// without re-querying. /*msgfeed-v65*/
function normalizeMsg(json) {
  try {
    const o = typeof json === 'string' ? JSON.parse(json) : json;
    const m = o && o.msg;
    if (Array.isArray(m)) return m.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join('\n');
    if (typeof m === 'string') return m;
    if (m != null) return JSON.stringify(m);
    return typeof json === 'string' ? json : JSON.stringify(o);
  } catch { return String(json == null ? '' : json); }
}

export async function getMessageFeed(opts = {}) {
  if (!_cfg) return { messages: [], scannedMax: null };
  const sinceId = Number(opts.sinceId) || 0;
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 500);
  const order = opts.order === 'asc' ? 'ASC' : 'DESC';   /*msgfeed-order-v67b*/
  const rows = await pgQuery(_cfg, `
    SELECT m.id::text AS id,
           encode(t.hash, 'hex') AS tx,
           (extract(epoch from b.time))::bigint::text AS ts,
           m.json::text AS json   /*msgfeed-jsonb-v65b*/
    FROM tx_metadata m
    JOIN tx t ON t.id = m.tx_id
    JOIN block b ON b.id = t.block_id
    WHERE m.key = 674 AND m.id > ${sinceId}
    ORDER BY m.id ${order}
    LIMIT ${limit}`);
  const messages = rows.map((r) => ({
    id: Number(r.id),
    tx: r.tx,
    ts: Number(r.ts),
    text: normalizeMsg(r.json),
  }));
  const scannedMax = messages.length ? Math.max(...messages.map((mm) => mm.id)) : sinceId;
  return { messages, scannedMax };
}

const PROVIDES = [
  DataKind.EPOCH_BLOCKS, DataKind.EPOCH_STAKE, DataKind.EPOCH_DELEGATORS,
  DataKind.EPOCH_REWARDS, DataKind.EPOCH_IDEAL, DataKind.POOL_PARAMS,
  DataKind.DELEGATOR_LOYALTY, DataKind.DELEGATOR_LIST, DataKind.DELEGATOR_DETAIL,
  DataKind.DELEGATOR_STAKE_HISTORY,
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
 * Live account state for one stake credential — the figures an explorer shows
 * on the account page, which the epoch_stake snapshot alone cannot give:
 *
 *   utxo             spendable lovelace in UTxOs controlled by this credential
 *   rewardsAvailable un-withdrawn reward-account balance (spendable rewards only)
 *   totalBalance     utxo + rewardsAvailable  (= Koios total_balance; excludes
 *                    the 2 ₳ key deposit, which the ledger holds separately)
 *
 * Three correctness points, all verified against Koios account_info:
 *  1. Rewards live in TWO tables since db-sync 13.2 — `reward` (member/leader)
 *     and `reward_rest` (treasury / reserves / proposal refunds). Summing only
 *     `reward` while `withdrawal` covers BOTH makes rewards−withdrawals go
 *     negative for any account that ever got a treasury or reserves payout.
 *  2. A reward row is only withdrawable from `spendable_epoch`, so the balance
 *     must filter on it — otherwise it overstates for ~2 epochs after payout.
 *  3. The UTxO set is the tx_out anti-join against tx_in. `consumed_by_tx_id`
 *     is also tested so the same SQL is right whether or not db-sync runs with
 *     consumed-tx-out / pruning enabled.
 * acct-live-v79
 */
async function getAccountNow(esc) {
  const utxoSql = `
    (SELECT COALESCE(SUM(txo.value),0) FROM tx_out txo
       LEFT JOIN tx_in ti ON ti.tx_out_id = txo.tx_id AND ti.tx_out_index = txo.index
      WHERE txo.stake_address_id = (SELECT id FROM a)
        AND txo.consumed_by_tx_id IS NULL AND ti.tx_in_id IS NULL)::text AS utxo`;
  const base = `
    (SELECT COALESCE(SUM(amount),0) FROM reward WHERE addr_id = (SELECT id FROM a))::text AS rewards,
    (SELECT COALESCE(SUM(amount),0) FROM reward WHERE addr_id = (SELECT id FROM a)
       AND spendable_epoch <= (SELECT MAX(no) FROM epoch))::text AS rewards_spendable,
    (SELECT COALESCE(SUM(amount),0) FROM withdrawal WHERE addr_id = (SELECT id FROM a))::text AS withdrawals,
    (SELECT MIN(epoch_no) FROM epoch_stake WHERE addr_id = (SELECT id FROM a))::text AS since`;
  const rest = `
    (SELECT COALESCE(SUM(amount),0) FROM reward_rest WHERE addr_id = (SELECT id FROM a))::text AS rest,
    (SELECT COALESCE(SUM(amount),0) FROM reward_rest WHERE addr_id = (SELECT id FROM a)
       AND spendable_epoch <= (SELECT MAX(no) FROM epoch))::text AS rest_spendable`;

  // reward_rest / consumed_by_tx_id are schema-version dependent — degrade to the
  // narrower query rather than losing the whole account panel on older db-sync.
  let row = null;
  for (const sel of [`${utxoSql},${base},${rest}`, `${base},${rest}`, base]) {
    try {
      const r = await pgQuery(_cfg, `WITH a AS (SELECT id FROM stake_address WHERE view = '${esc}') SELECT ${sel}`);
      if (r.length) { row = r[0]; break; }
    } catch (e) { console.warn('[dbsync] account-now degraded:', e.message ?? e); }
  }
  if (!row) return null;

  const n = (v) => (v == null ? 0 : Number(v));
  const rewardsEarned = n(row.rewards) + n(row.rest);
  const spendable = n(row.rewards_spendable) + n(row.rest_spendable);
  const withdrawn = n(row.withdrawals);
  const utxo = row.utxo != null ? n(row.utxo) : null;
  const available = Math.max(0, spendable - withdrawn);
  return {
    utxo: lovelaceToAda(utxo),
    rewardsAvailable: lovelaceToAda(available),
    totalBalance: utxo == null ? null : lovelaceToAda(utxo + available),
    rewardsEarned: lovelaceToAda(rewardsEarned),
    withdrawn: lovelaceToAda(withdrawn),
    pendingRewards: lovelaceToAda(rewardsEarned - spendable),   // earned, not yet spendable
    sinceEpoch: numOrNull(row.since),
    asOf: 'live',
  };
}

/**
 * DELEGATOR_DETAIL - one-delegator deep-dive, same shape as the Blockfrost
 * provider so the modal is source-agnostic. db-sync is local/instant, so this
 * queries live each open (no API budget to protect). `balance` here is the
 * delegator's active stake at the latest epoch snapshot (db-sync's authoritative
 * figure); the live account figures (UTxO + undrawn rewards) come from
 * getAccountNow and are what an explorer's account page shows.
 */
async function getDelegatorDetail(stake, currentEpoch) {
  if (!_ready || !stake) return null;
  const esc = String(stake).replace(/'/g, "''");

  // Per-epoch stake history across ALL pools (oldest first) -> pool-movement runs.
  const hist = await pgQuery(_cfg, `
    SELECT es.epoch_no::text AS epoch, ph.view AS pool, es.amount::text AS amount,
           ocp.ticker_name AS ticker
    FROM epoch_stake es
    JOIN stake_address sa ON sa.id = es.addr_id
    JOIN pool_hash ph ON ph.id = es.pool_id
    LEFT JOIN LATERAL (
      SELECT ticker_name FROM off_chain_pool_data
      WHERE pool_id = es.pool_id ORDER BY id DESC LIMIT 1
    ) ocp ON true
    WHERE sa.view = '${esc}'
    ORDER BY es.epoch_no ASC`);

  // Live account state: UTxO, undrawn rewards, lifetime rewards/withdrawals.
  const acct = await getAccountNow(esc);

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
        ticker: row.ticker || null,   // from off_chain_pool_data (db-sync local)
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
  // Active NOW = newest snapshot at or below the tip; `lastRow` is normally the
  // next epoch's pre-computed snapshot. /*next-epoch-snap-v80*/
  const { current: curRow, next: nextRow } = splitAtTip(hist, currentEpoch);

  return {
    stake,
    balance: curRow ? lovelaceToAda(curRow.amount) : null,     // active stake @ current snapshot
    snapshotEpoch: curRow ? Number(curRow.epoch) : null,
    nextEpoch: nextRow ? Number(nextRow.epoch) : null,
    nextStake: nextRow ? lovelaceToAda(nextRow.amount) : null,
    rewardsSum: acct ? acct.rewardsEarned : null,
    withdrawalsSum: acct ? acct.withdrawn : null,
    withdrawable: acct ? acct.rewardsAvailable : null,
    account: acct,                                             // live: utxo + undrawn rewards
    sinceEpoch: acct ? acct.sinceEpoch : null,
    drepId,
    currentPool: lastRow ? lastRow.pool : null,
    cameFrom,
    runs,
  };
}

/* Most recent movements returned. The scan is already bounded by the account's
 * own output count (the stake_address_id index), so this only caps rendering.
 * The modal states when it truncates rather than implying completeness.
 * utxo-moves-v81 */
const TRANSFER_ROW_LIMIT = 300;

/**
 * Per-tx balance movements for one stake account — the ADA that actually moved
 * in and out, which rewards/withdrawals alone never show. utxo-moves-v81
 *
 * WHY THIS EXISTS: a delegator's balance changing is the single most common
 * question the movements tab gets asked, and until now it could not answer it —
 * a 500 ADA deposit appeared nowhere, because it is neither a reward nor a
 * withdrawal. The per-epoch series shows the same money two epochs later as an
 * unexplained step. This closes that gap.
 *
 * `net` per tx = value received by the account's addresses − value spent from
 * them − any reward withdrawal in the same tx. Subtracting the withdrawal is
 * what stops it being double counted: it already has its own row, and without
 * this the tx would read as free money arriving rather than a fee being paid.
 *
 * SPEND DETECTION — why both sources are unioned rather than one picked:
 * db-sync can record a spend in `tx_in`, or as `tx_out.consumed_by_tx_id` when
 * consumed-tx-out mode is on, and an installation can be mid-way between the
 * two. Measured on a real 15.50.6 node here: `tx_in` held 339M rows while only
 * 39.8M of 353M `tx_out` rows carried `consumed_by_tx_id`. Picking the wrong one
 * does NOT error — it silently under-reports spends, which is the worst possible
 * failure for a balance view. A UTxO can be spent only once, so UNION-ing both
 * and de-duplicating on the output id is correct whichever mode is in force.
 *
 * PERFORMANCE — the shape matters. Bounding the scan by a tx-id floor derived
 * from `block.epoch_no` cost 11s on its own (that MIN/MAX walk, not the account
 * work). The `stake_address_id` index already bounds the scan to one account's
 * outputs, so there is no floor at all: measured 48ms for a 1178-output account,
 * 310ms for the worst of a sampled set. Do not reintroduce an epoch floor.
 * Equally, a `LEFT JOIN … COALESCE(i.tx_in_id, o.consumed_by_tx_id)` reads as
 * tidier but gives the planner no selective predicate and hash-joins all of
 * `tx_in` — it ran past two minutes. Keep the two scans separate.
 *
 * SCHEMA VARIANT: `tx_out.stake_address_id` (default, verified here) or a join
 * through `address` when db-sync runs with `tx_out.use_address_table`. That one
 * fails loudly on a missing column, so trying it second is safe. UNVERIFIED —
 * there was no address-table install to test against.
 */
async function getAccountTransfers(esc) {
  // `outs` is every output ever paid to this stake credential — the one scan
  // that matters, and the index makes it cheap.
  const build = (useAddrTable) => `
    WITH a AS (SELECT id FROM stake_address WHERE view = '${esc}'),
    outs AS (
      SELECT o.id, o.tx_id, o.index, o.value, o.consumed_by_tx_id
      FROM tx_out o
      ${useAddrTable
        ? 'JOIN address ad ON ad.id = o.address_id WHERE ad.stake_address_id = (SELECT id FROM a)'
        : 'WHERE o.stake_address_id = (SELECT id FROM a)'}
    ),
    spent_rows AS (
      SELECT i.tx_in_id AS tx_id, o.id AS out_id, o.value
      FROM outs o JOIN tx_in i ON i.tx_out_id = o.tx_id AND i.tx_out_index = o.index
      UNION
      SELECT o.consumed_by_tx_id AS tx_id, o.id AS out_id, o.value
      FROM outs o WHERE o.consumed_by_tx_id IS NOT NULL
    ),
    spent AS (SELECT tx_id, SUM(value) AS amt FROM spent_rows GROUP BY tx_id),
    recv  AS (SELECT tx_id, SUM(value) AS amt FROM outs GROUP BY tx_id),
    wd AS (
      SELECT w.tx_id, SUM(w.amount) AS amt FROM withdrawal w
      WHERE w.addr_id = (SELECT id FROM a) GROUP BY w.tx_id
    ),
    ids AS (SELECT tx_id FROM recv UNION SELECT tx_id FROM spent)
    SELECT b.epoch_no::text AS epoch,
           (COALESCE(r.amt,0) - COALESCE(s.amt,0) - COALESCE(w.amt,0))::text AS net,
           encode(t.hash,'hex') AS txhash,
           to_char(b.time,'YYYY-MM-DD"T"HH24:MI:SS"+00:00"') AS at
    FROM ids
    JOIN tx t ON t.id = ids.tx_id
    JOIN block b ON b.id = t.block_id
    LEFT JOIN recv r ON r.tx_id = ids.tx_id
    LEFT JOIN spent s ON s.tx_id = ids.tx_id
    LEFT JOIN wd w ON w.tx_id = ids.tx_id
    ORDER BY t.id DESC
    LIMIT ${TRANSFER_ROW_LIMIT}`;

  for (const useAddrTable of [false, true]) {
    try {
      const rows = await pgQuery(_cfg, build(useAddrTable));
      return (rows || []).map((r) => ({
        epoch: numOrNull(r.epoch),
        kind: 'transfer',
        amount: lovelaceToAda(r.net),
        txHash: r.txhash || null,
        at: r.at || null,
      })).filter((t) => t.amount !== 0);       // a tx that nets to zero moved nothing
    } catch (e) {
      console.warn(`[dbsync] transfers (addressTable=${useAddrTable}) failed:`, e.message ?? e);
    }
  }
  return [];                                   // degrade to rewards/withdrawals only
}

/**
 * DELEGATOR_STAKE_HISTORY - per-epoch active-stake series for one delegator,
 * plus intra-epoch tx-level movements (db-sync exclusive). Source-agnostic shape
 * so the modal renders the same regardless of provider; Koios/Blockfrost return
 * epochs only (no events).
 */
async function getDelegatorStakeHistory(stake, currentEpoch) {
  if (!_ready || !stake) return null;
  const esc = String(stake).replace(/'/g, "''");

  // Per-epoch active stake (oldest -> newest). Sums across pools so the figure is
  // the delegator's TOTAL active stake each epoch, not just our pool's slice.
  const rows = await pgQuery(_cfg, `
    SELECT es.epoch_no::text AS epoch, SUM(es.amount)::text AS amount
    FROM epoch_stake es
    JOIN stake_address sa ON sa.id = es.addr_id
    WHERE sa.view = '${esc}'
    GROUP BY es.epoch_no
    ORDER BY es.epoch_no ASC`);

  const epochs = [];
  let prev = null;
  for (const r of rows) {
    const bal = lovelaceToAda(r.amount);
    const delta = (prev == null || bal == null) ? null : (bal - prev);
    epochs.push({ epoch: Number(r.epoch), stake: bal, delta, runningBalance: bal });
    prev = bal;
  }

  // Intra-epoch events: rewards (in), withdrawals (out).
  // Exact from dedicated tables — no UTxO reconstruction. `reward_rest` carries
  // treasury / reserves / proposal-refund payouts, which are real credits to the
  // reward account and were previously missing from this list entirely.
  // /*acct-live-v79*/
  const events = [];
  const restSql = `
      UNION ALL
      SELECT rr.type::text AS kind, rr.earned_epoch::text AS epoch, rr.amount::text AS amount, NULL AS txhash
      FROM reward_rest rr WHERE rr.addr_id = (SELECT id FROM a)`;
  const evSql = (withRest) => `
      WITH a AS (SELECT id FROM stake_address WHERE view = '${esc}')
      SELECT * FROM (
      SELECT 'reward' AS kind, r.earned_epoch::text AS epoch, r.amount::text AS amount, NULL AS txhash
      FROM reward r WHERE r.addr_id = (SELECT id FROM a)${withRest ? restSql : ''}
      UNION ALL
      SELECT 'withdrawal' AS kind, e.no::text AS epoch, w.amount::text AS amount, encode(tx.hash,'hex') AS txhash
      FROM withdrawal w
      JOIN tx ON tx.id = w.tx_id
      JOIN block b ON b.id = tx.block_id
      JOIN epoch e ON e.no = b.epoch_no
      WHERE w.addr_id = (SELECT id FROM a)
      ) ev ORDER BY epoch::bigint ASC`;
  let rw = null;
  for (const withRest of [true, false]) {           // reward_rest is schema 13.2+
    try { rw = await pgQuery(_cfg, evSql(withRest)); break; }
    catch (e) { console.warn('[dbsync] stake-history events failed:', e.message ?? e); }
  }
  for (const r of (rw || [])) {
    const amt = lovelaceToAda(r.amount);
    events.push({
      epoch: numOrNull(r.epoch),
      kind: r.kind,
      amount: r.kind === 'withdrawal' ? (amt == null ? null : -amt) : amt,
      txHash: r.txhash || null,
    });
  }

  // ADA moved in/out per tx — the movements rewards/withdrawals can't show.
  // Bounded window, so it is reported alongside. /*utxo-moves-v81*/
  const transfers = await getAccountTransfers(esc);

  const account = await getAccountNow(esc);
  // epoch_stake carries the NEXT epoch's snapshot as soon as db-sync has it, so
  // the reconciliation basis is the newest row at or below the tip, not the
  // newest row. /*next-epoch-snap-v80*/
  const { current, next, tip } = splitAtTip(epochs, currentEpoch);
  return {
    stake,
    source: 'dbsync',
    granularity: 'epoch+intra',
    epochs,
    events,
    transfers,                                      // [{epoch, kind:'transfer', amount, txHash, at}]
    transfersTruncated: transfers.length >= TRANSFER_ROW_LIMIT,   // UI says so rather than implying completeness
    account,                                        // live UTxO + undrawn rewards
    currentEpoch: tip,
    snapshotEpoch: current ? current.epoch : null,
    snapshotStake: current ? current.runningBalance : null,
    nextEpoch: next ? next.epoch : null,            // already snapshotted, starts later
    nextStake: next ? next.runningBalance : null,
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
      case DataKind.DELEGATOR_STAKE_HISTORY:
        return getDelegatorStakeHistory(params.stake, params.currentEpoch);
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
