/**
 * PoolTerminal — Koios access layer.
 *
 * Koios (https://api.koios.rest) is the PORTABLE historical/enrichment source:
 * every SPO can reach it, no install, no db-sync required. It is NOT used for
 * current-epoch leader election — that stays on cardano-cli `stakeGo` (see the
 * data-source map in MANUAL.md §4). Koios feeds live stake, delegator counts,
 * saturation, and per-epoch history (the HISTORY / DELEGATORS views).
 *
 * Transport: like geo-query.js, we run `curl` ON THE NODE over the existing
 * SSH session — the node has internet egress, the WebView hits CORS walls.
 * No reqwest crate, no CSP changes, fully portable.
 *
 * All functions are defensive: on any SSH/curl/parse failure they log and
 * return null (objects) or [] (lists) rather than throwing, so a Koios outage
 * degrades gracefully to "stale at 60% opacity" per DESIGN.md, never a crash.
 *
 * Rate limits: Koios free tier is generous but finite. Our cadence is low by
 * design — backfill is ONE call, semi-live samples every few minutes, per-epoch
 * snapshots once per epoch. Every call carries --max-time.
 */

import { invoke } from './tauri.js';

const KOIOS_BASE = 'https://api.koios.rest/api/v1';
const CURL_MAX_TIME = 8; // seconds, per call

/**
 * Run a command on the node over SSH, returning stdout (or '' on failure).
 * Mirrors the helper in geo-query.js so behaviour is identical across modules.
 */
async function runCmd(command) {
  const r = await invoke('ssh_run', { command });
  if (typeof r === 'string') return r;
  return r?.stdout ?? '';
}

/** Single-quote shell-escape for embedding a JSON body in a curl -d '...'. */
function shellEscape(s) {
  return s.replace(/'/g, "'\\''");
}

/** Parse curl stdout as JSON; return fallback ([] or null) on empty/bad output. */
function parseJson(out, fallback) {
  if (!out || !out.trim()) return fallback;
  try {
    return JSON.parse(out);
  } catch (err) {
    console.warn('[koios] parse failed:', err.message);
    return fallback;
  }
}

/** lovelace string/number → ADA (number). Pool-level values stay under 2^53. */
export function lovelaceToAda(lovelace) {
  if (lovelace == null) return null;
  return Number(lovelace) / 1_000_000;
}

// ============================================================
// pool_info — live, current pool state (POST)
// ============================================================

/**
 * Live pool state. Returns a normalised object or null.
 *
 * NOTE on snapshots (validated against stake-snapshot):
 *   - activeStake  = Koios "active_stake"  = the SET snapshot (NEXT epoch)
 *   - votingPower  = Koios "voting_power"  = the MARK snapshot (newest)
 *   - sigma        = Koios "sigma"         = computed off active_stake (Set)
 * For CURRENT-epoch leader math use cli stakeGo, NOT these. These are correct
 * for "what's coming" displays and for live_* fields below.
 *
 *   - opCertCounter reflects the ON-CHAIN counter — it only advances when the
 *     pool next forges with a new cert, so it can lag the running node's value.
 */
export async function getPoolInfo(poolBech32) {
  const body = JSON.stringify({ _pool_bech32_ids: [poolBech32] });
  const cmd =
    `curl -sf --max-time ${CURL_MAX_TIME} -X POST '${KOIOS_BASE}/pool_info' ` +
    `-H 'content-type: application/json' -d '${shellEscape(body)}'`;

  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[koios] pool_info SSH failure:', err.message);
    return null;
  }

  const arr = parseJson(out, null);
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const p = arr[0];

  return {
    poolIdBech32:   p.pool_id_bech32,
    poolIdHex:      p.pool_id_hex,
    activeEpochNo:  p.active_epoch_no,
    status:         p.pool_status,          // 'registered' | 'retiring' | 'retired'
    retiringEpoch:  p.retiring_epoch,
    margin:         p.margin,
    fixedCost:      lovelaceToAda(p.fixed_cost),
    pledge:         lovelaceToAda(p.pledge),
    livePledge:     lovelaceToAda(p.live_pledge),
    liveStake:      lovelaceToAda(p.live_stake),
    activeStake:    lovelaceToAda(p.active_stake),   // SET snapshot — not stakeGo
    votingPower:    lovelaceToAda(p.voting_power),   // MARK snapshot
    sigma:          p.sigma,                          // off active_stake (Set)
    liveSaturation: p.live_saturation,                // percent, e.g. 1.23
    liveDelegators: p.live_delegators,
    blockCountLifetime: p.block_count,
    opCertCounter:  p.op_cert_counter,                // ON-CHAIN counter (may lag node)
    rewardAddr:     p.reward_addr,
    delegatedDrep:  p.reward_addr_delegated_drep,
    relays:         Array.isArray(p.relays) ? p.relays : [],
    metaUrl:        p.meta_url,
    raw:            p,
  };
}

// ============================================================
// pool_history — per-epoch history (GET)
// ============================================================

/**
 * Per-epoch history, newest-first. `limit` 0/undefined = all epochs (one call,
 * used for first-run backfill). Returns an array (possibly empty).
 *
 * Each record carries everything the HISTORY view and the read-model need:
 * active_stake, delegator_cnt, block_cnt (= produced/confirmed blocks, Koios
 * only counts canonical), saturation, rewards, ROS, and active_stake_pct from
 * which Ideal is derived (pct/100 × 21600).
 */
export async function getPoolHistory(poolBech32, { limit = 0, order = 'desc' } = {}) {
  let url = `${KOIOS_BASE}/pool_history?_pool_bech32=${poolBech32}&order=epoch_no.${order}`;
  if (limit > 0) url += `&limit=${limit}`;
  const cmd = `curl -sf --max-time ${CURL_MAX_TIME} '${url}'`;

  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[koios] pool_history SSH failure:', err.message);
    return [];
  }

  const arr = parseJson(out, []);
  if (!Array.isArray(arr)) return [];

  return arr.map((h) => {
    const pct = h.active_stake_pct;            // PERCENT, e.g. 0.004724929 (= σ×100)
    const sigma = pct == null ? null : pct / 100;
    return {
      epoch:        h.epoch_no,
      activeStake:  lovelaceToAda(h.active_stake),
      activeStakePct: pct,
      sigma,
      ideal:        sigma == null ? null : Math.round(sigma * 21600 * 100) / 100,
      saturation:   h.saturation_pct,
      blockCount:   h.block_cnt,               // produced & confirmed (canonical)
      delegators:   h.delegator_cnt,
      margin:       h.margin,
      fixedCost:    lovelaceToAda(h.fixed_cost),
      poolFees:     lovelaceToAda(h.pool_fees),
      delegRewards: lovelaceToAda(h.deleg_rewards),
      memberRewards: lovelaceToAda(h.member_rewards),
      ros:          h.epoch_ros,               // member return-on-stake %, annualised
      raw:          h,
    };
  });
}

// ============================================================
// pool_blocks — individual blocks, optionally scoped to an epoch (GET)
// ============================================================

/**
 * Blocks produced by the pool. If `epochNo` is given, scopes to that epoch —
 * used for the CURRENT-epoch produced count (pool_history lags behind the live
 * epoch) and for a future block-log view. Returns an array (possibly empty).
 */
export async function getPoolBlocks(poolBech32, epochNo = null) {
  let url = `${KOIOS_BASE}/pool_blocks?_pool_bech32=${poolBech32}`;
  if (epochNo != null) url += `&_epoch_no=${epochNo}`;
  const cmd = `curl -sf --max-time ${CURL_MAX_TIME} '${url}'`;

  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[koios] pool_blocks SSH failure:', err.message);
    return [];
  }

  const arr = parseJson(out, []);
  if (!Array.isArray(arr)) return [];

  return arr.map((b) => ({
    epoch:       b.epoch_no,
    absSlot:     b.abs_slot,
    epochSlot:   b.epoch_slot,
    blockHeight: b.block_height,
    blockHash:   b.block_hash,
    blockTime:   b.block_time,   // unix seconds
    raw:         b,
  }));
}

/** Count of canonical blocks the pool produced in a given epoch (live-safe). */
export async function getEpochBlockCount(poolBech32, epochNo) {
  const blocks = await getPoolBlocks(poolBech32, epochNo);
  return blocks.length;
}

// ============================================================
// pool_delegators — current delegator list (GET) — for DELEGATORS view
// ============================================================

/**
 * Current delegators with their stake. Returns an array (possibly empty).
 * Koios paginates at 1000 rows; for pools larger than that we'd page with
 * offset — GNP1 (~138) fits in one call.
 */
export async function getPoolDelegators(poolBech32) {
  const url = `${KOIOS_BASE}/pool_delegators?_pool_bech32=${poolBech32}&order=amount.desc`;
  const cmd = `curl -sf --max-time ${CURL_MAX_TIME} '${url}'`;

  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[koios] pool_delegators SSH failure:', err.message);
    return [];
  }

  const arr = parseJson(out, []);
  if (!Array.isArray(arr)) return [];

  return arr.map((d) => ({
    stakeAddress:    d.stake_address,
    amount:          lovelaceToAda(d.amount),
    activeEpochNo:   d.active_epoch_no,
    latestDelegTx:   d.latest_delegation_tx_hash,
    raw:             d,
  }));
}
