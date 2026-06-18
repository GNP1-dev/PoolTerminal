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
 * TRANSPORT SEAM (planned, see MANUAL §4.7): the curl-over-SSH transport is
 * isolated to runCmd() below. A future install-wizard option will let the
 * operator choose where public-API calls run — via the node (this, default),
 * via the host machine (Rust reqwest, for egress-locked BPs), or offline from
 * a pre-built seed DB (air-gapped). When that lands, only runCmd() changes;
 * every fetch function and the read-model stay transport-agnostic.
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
import { DataKind, registry } from './capabilities.js';

const KOIOS_BASE = 'https://api.koios.rest/api/v1';
const CURL_MAX_TIME = 8; // seconds, per call
const ACCOUNT_INFO_MAX_TIME = 15; // account_info pages (50 addrs) are heavier — give them room

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
// epoch_info — network-wide totals for an epoch (GET)
// ============================================================

/**
 * Network-wide figures for one epoch. Returns a normalised object or null.
 *
 * Why this exists: Koios pool_history.active_stake_pct (the pool's share of
 * active stake) is only populated for RECENT epochs — it is null for the bulk
 * of historical epochs. So Ideal cannot be derived from pool_history alone for
 * old epochs. epoch_info gives the network's total `active_stake` (the correct
 * denominator — delegated stake, NOT total supply) and the real `blk_count`
 * minted that epoch, letting us compute Ideal correctly for every epoch:
 *
 *   σ(epoch)     = pool_active_stake / network_active_stake
 *   ideal(epoch) = σ × blk_count        (real network blocks, not the 21600 const)
 *
 * Past epochs are finalised, so this is computed once and cached forever.
 */
export async function getEpochInfo(epochNo) {
  const url = `${KOIOS_BASE}/epoch_info?_epoch_no=${epochNo}`;
  const cmd = `curl -sf --max-time ${CURL_MAX_TIME} '${url}'`;

  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[koios] epoch_info SSH failure:', err.message);
    return null;
  }

  const arr = parseJson(out, null);
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const e = arr[0];

  return {
    epoch:                 e.epoch_no,
    networkActiveStake:    lovelaceToAda(e.active_stake),
    networkActiveStakeRaw: e.active_stake,   // string lovelace — denominator for σ
    blkCount:              e.blk_count,       // real blocks minted network-wide
    startTime:             e.start_time,
    endTime:               e.end_time,
    era:                   e.era,
    raw:                   e,
  };
}

// ============================================================
// account_rewards — operator (leader) reward for a stake address (POST)
// ============================================================

/**
 * Leader (operator) reward earned by a reward/stake address in an epoch.
 * Returns ADA (number) or null if none / not yet published.
 *
 * This is the operator's TOTAL reward that epoch (fixed fee + margin + reward on
 * own pledge stake). Combined with pool params it splits into the components the
 * HISTORY table shows:
 *   marginEarn   = margin × (leader − fixed_cost)
 *   pledgeReward = leader − fixed_cost − marginEarn
 * (Delegator rewards come separately from pool_history.member_rewards.)
 *
 * A zero-block epoch has no leader row → 0 (finalised fact, not unknown).
 */
export async function getLeaderReward(stakeAddress, epochNo) {
  const body = JSON.stringify({ _stake_addresses: [stakeAddress], _epoch_no: epochNo });
  const cmd =
    `curl -sf --max-time ${CURL_MAX_TIME} -X POST '${KOIOS_BASE}/account_rewards' ` +
    `-H 'content-type: application/json' -d '${shellEscape(body)}'`;

  let out;
  try {
    out = await runCmd(cmd);
  } catch (err) {
    console.warn('[koios] account_rewards SSH failure:', err.message);
    return null;
  }

  const arr = parseJson(out, null);
  if (!Array.isArray(arr) || arr.length === 0) return null;       // not published yet → null
  const rewards = arr[0].rewards;
  if (!Array.isArray(rewards)) return 0;
  const leader = rewards.find((r) => r.type === 'leader');
  return leader ? lovelaceToAda(leader.amount) : 0;               // no leader row = 0 earned
}

/**
 * Current delegators with their LIVE stake, fully paged. Returns an array
 * (possibly empty).
 *
 * `amount` from Koios is LIVE stake — it moves intra-epoch as a delegator's
 * balance changes, which is exactly the signal the NOTIFICATIONS diff watches
 * (stake up / down), unlike the epoch_stake snapshot that only moves at epoch
 * boundaries. `latest_delegation_tx_hash` lets a redelegation be distinguished
 * from a same-pool stake change.
 *
 * Koios returns up to 1000 rows per page; we page with `offset` until a short
 * page comes back, so this is honest for a pool of ANY size — not just those
 * under 1000 (genericness: this app targets every SPO, not just GNP1's ~140).
 * MAX_PAGES is a safety cap so a bad response can never loop unbounded.
 *
 * Canonical shape (source-agnostic — Blockfrost/db-sync providers emit the same):
 *   { stake, liveStake (ADA), liveStakeLovelace, latestDelegTx|null, activeEpochNo|null }
 */
export async function getPoolDelegators(poolBech32) {
  const PAGE = 1000;
  const MAX_PAGES = 50;   // 50k delegators — far beyond any real pool; just a guard
  const out = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE;
    const url =
      `${KOIOS_BASE}/pool_delegators?_pool_bech32=${poolBech32}` +
      `&order=amount.desc&offset=${offset}`;
    const cmd = `curl -sf --max-time ${CURL_MAX_TIME} '${url}'`;

    let res;
    try {
      res = await runCmd(cmd);
    } catch (err) {
      console.warn('[koios] pool_delegators SSH failure:', err.message);
      break;   // return what we have so far — defensive, never throw into the loop
    }

    const arr = parseJson(res, []);
    if (!Array.isArray(arr) || arr.length === 0) break;

    for (const d of arr) {
      const lov = d.amount == null ? 0 : Number(d.amount);
      out.push({
        stake:             d.stake_address,
        liveStake:         lov / 1_000_000,
        liveStakeLovelace: lov,
        latestDelegTx:     d.latest_delegation_tx_hash || null,
        activeEpochNo:     d.active_epoch_no ?? null,
      });
    }

    if (arr.length < PAGE) break;   // short page = last page
  }

  // CRITICAL: pool_delegators.amount is the epoch-BOUNDARY snapshot stake — it
  // does NOT move intra-epoch, so it's useless for stake-change detection
  // (verified: a mid-epoch send leaves it unchanged). Overlay the genuinely
  // live balance from account_info.total_balance — the same number pool.pm and
  // friends watch. pool_delegators still defines MEMBERSHIP (who delegates to
  // us, which does change intra-epoch as certs land); account_info supplies the
  // live amount.
  //
  // STRICT, ALL-OR-NOTHING: we must NEVER fall back to pool_delegators' snapshot
  // amount for an address. That's a different metric, and diffing a snapshot
  // value against a live baseline produces phantom stake_up/down events AND
  // corrupts the stored baseline (observed in testing). So if even ONE member's
  // live balance is unresolved, we discard the whole result and return [] — the
  // read-model treats that exactly like a Koios outage: skip the poll, emit
  // nothing, leave the last good snapshot untouched, retry next cycle. Stale but
  // correct always beats fast but wrong.
  if (out.length) {
    let balances = new Map();
    try {
      balances = await getAccountsBalances(out.map((d) => d.stake));
    } catch (err) {
      console.warn('[koios] balance overlay threw:', err.message);
      balances = new Map();
    }
    let missing = 0;
    for (const d of out) {
      const live = balances.get(d.stake);
      if (live == null) { missing++; continue; }
      d.liveStakeLovelace = live;
      d.liveStake = live / 1_000_000;
    }
    if (missing > 0) {
      console.warn(
        `[koios] live-balance overlay incomplete: ${missing}/${out.length} unresolved — ` +
        `skipping this poll (no events, snapshot untouched) to avoid mixing snapshot stake with live`
      );
      return [];
    }
  }

  return out;
}

/**
 * Live total balance per stake address (Koios account_info.total_balance,
 * batched and paged at 50/req). Returns Map(stake_address -> lovelace). This is
 * the LIVE, intra-epoch balance — what actually moves when a delegator sends or
 * receives ADA — as opposed to pool_delegators' boundary snapshot. Defensive:
 * skips a page on failure, returns whatever it gathered.
 */
export async function getAccountsBalances(stakeAddresses) {
  const out = new Map();
  if (!Array.isArray(stakeAddresses) || stakeAddresses.length === 0) return out;

  const PAGE = 50;          // Koios bulk POST batch size
  const MAX_ATTEMPTS = 2;   // one retry — smooths transient Koios/SSH hiccups so
                            // a single flaky page doesn't degrade the whole poll
  for (let i = 0; i < stakeAddresses.length; i += PAGE) {
    const batch = stakeAddresses.slice(i, i + PAGE);
    const body = JSON.stringify({ _stake_addresses: batch });
    const cmd =
      `curl -sf --max-time ${ACCOUNT_INFO_MAX_TIME} -X POST '${KOIOS_BASE}/account_info' ` +
      `-H 'content-type: application/json' -d '${shellEscape(body)}'`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res;
      try {
        res = await runCmd(cmd);
      } catch (err) {
        console.warn(`[koios] account_info page @${i} attempt ${attempt} SSH failure:`, err.message);
        continue;
      }
      const arr = parseJson(res, null);
      if (!Array.isArray(arr)) {
        console.warn(`[koios] account_info page @${i} attempt ${attempt}: non-array response`);
        continue;
      }
      for (const a of arr) {
        const tb = a.total_balance == null ? null : Number(a.total_balance);
        if (tb != null) out.set(a.stake_address, tb);
      }
      break;   // page succeeded — stop retrying
    }
    // If a page never succeeded, its addresses stay absent from `out`; the caller
    // (getPoolDelegators) detects the incomplete coverage and skips the poll.
  }
  return out;
}

/**
 * Current delegated pool for each stake address (Koios account_info, ONE POST
 * for the whole batch). Returns Map(stake_address -> poolBech32 | null), null
 * meaning the account isn't currently delegating (deregistered / withdrawn).
 * Used by the NOTIFICATIONS engine to tell a redelegation from a leave-to-wallet
 * when a delegator drops off the pool's list. Defensive: returns an empty Map on
 * any failure so a classification miss never loses the underlying leave event.
 */
export async function getAccountsDelegatedPool(stakeAddresses) {
  const out = new Map();
  if (!Array.isArray(stakeAddresses) || stakeAddresses.length === 0) return out;

  const body = JSON.stringify({ _stake_addresses: stakeAddresses });
  const cmd =
    `curl -sf --max-time ${CURL_MAX_TIME} -X POST '${KOIOS_BASE}/account_info' ` +
    `-H 'content-type: application/json' -d '${shellEscape(body)}'`;

  let res;
  try {
    res = await runCmd(cmd);
  } catch (err) {
    console.warn('[koios] account_info SSH failure:', err.message);
    return out;
  }

  const arr = parseJson(res, []);
  if (!Array.isArray(arr)) return out;
  for (const a of arr) out.set(a.stake_address, a.delegated_pool || null);
  return out;
}

/**
 * Prior pool for each stake address — the most recent pool they delegated to
 * that ISN'T `ourPoolBech32` (Koios account_history, ONE POST for the batch).
 * Returns Map(stake_address -> priorPoolBech32 | null); null = no earlier pool
 * (a brand-new delegator). Lets the NOTIFICATIONS engine tell a fresh join from
 * a redelegation IN. Defensive: empty Map on any failure (joiner then shown as
 * plain new, never lost).
 */
export async function getAccountsPriorPool(stakeAddresses, ourPoolBech32) {
  const out = new Map();
  if (!Array.isArray(stakeAddresses) || stakeAddresses.length === 0) return out;

  const body = JSON.stringify({ _stake_addresses: stakeAddresses });
  const cmd =
    `curl -sf --max-time ${CURL_MAX_TIME} -X POST '${KOIOS_BASE}/account_history' ` +
    `-H 'content-type: application/json' -d '${shellEscape(body)}'`;

  let res;
  try {
    res = await runCmd(cmd);
  } catch (err) {
    console.warn('[koios] account_history SSH failure:', err.message);
    return out;
  }

  const arr = parseJson(res, []);
  if (!Array.isArray(arr)) return out;
  for (const a of arr) {
    const hist = Array.isArray(a.history) ? a.history.slice() : [];
    hist.sort((x, y) => (y.epoch_no || 0) - (x.epoch_no || 0));   // newest epoch first
    let origin = null;
    for (const h of hist) {
      const p = h.pool_id_bech32 || h.pool_id || null;
      if (p && p !== ourPoolBech32) { origin = p; break; }
    }
    out.set(a.stake_address, origin);
  }
  return out;
}

/**
 * Ticker for each pool id (Koios pool_info accepts a batch of bech32 ids in one
 * POST). Returns Map(pool_id_bech32 -> ticker | null). Used to render
 * redelegation source/destination pools as tickers instead of raw ids.
 * Defensive: empty Map on failure (caller falls back to showing the id).
 */
export async function getPoolTickers(poolBech32Ids) {
  const out = new Map();
  if (!Array.isArray(poolBech32Ids) || poolBech32Ids.length === 0) return out;

  const body = JSON.stringify({ _pool_bech32_ids: poolBech32Ids });
  const cmd =
    `curl -sf --max-time ${CURL_MAX_TIME} -X POST '${KOIOS_BASE}/pool_info' ` +
    `-H 'content-type: application/json' -d '${shellEscape(body)}'`;

  let res;
  try {
    res = await runCmd(cmd);
  } catch (err) {
    console.warn('[koios] pool_info (tickers) SSH failure:', err.message);
    return out;
  }

  const arr = parseJson(res, []);
  if (!Array.isArray(arr)) return out;
  for (const p of arr) {
    const ticker = (p.meta_json && p.meta_json.ticker) ? p.meta_json.ticker : null;
    out.set(p.pool_id_bech32, ticker);
  }
  return out;
}

// ============================================================
// Live-delegators capability provider (NOTIFICATIONS)
// ============================================================
// Koios is the zero-config DEFAULT source for the live delegator set: no key,
// reachable by every SPO. It's registered into the capability spine as its own
// source object so the read-model can ask for DELEGATOR_LIST_LIVE without ever
// naming Koios — the setup wizard will later let an operator prefer Blockfrost
// or db-sync for the same kind with no change to the notifications code.
//
// Deliberately INDEPENDENT of the Koios *history* source (koios-history.js):
// history may be served by db-sync (the KOIOS_ENABLED history gate off) while
// live notifications still run on Koios — exactly how live block production
// already uses Koios regardless of the history toggle. Hence the distinct
// source id 'koios-live', which also avoids colliding with the history source's
// registration guard.

let _liveBech32 = null;
let _liveReady = false;

/**
 * DELEGATOR_DETAIL - one-delegator deep-dive from Koios (account_info +
 * account_history), same shape as the db-sync/Blockfrost providers so the modal
 * is source-agnostic. ~2 calls, on demand.
 */
export async function getDelegatorDetail(stake, _currentEpoch) {
  if (!stake) return null;
  const body = JSON.stringify({ _stake_addresses: [stake] });
  const toAda = (v) => (v == null ? null : Number(v) / 1e6);

  let info = null;
  try {
    const r = await runCmd(`curl -sf --max-time ${ACCOUNT_INFO_MAX_TIME} -X POST '${KOIOS_BASE}/account_info' ` +
      `-H 'content-type: application/json' -d '${shellEscape(body)}'`);
    const arr = parseJson(r, []);
    if (Array.isArray(arr) && arr.length) info = arr[0];
  } catch (e) { console.warn('[koios] detail account_info failed:', e.message); }

  let hist = [];
  try {
    const r = await runCmd(`curl -sf --max-time ${CURL_MAX_TIME} -X POST '${KOIOS_BASE}/account_history' ` +
      `-H 'content-type: application/json' -d '${shellEscape(body)}'`);
    const arr = parseJson(r, []);
    if (Array.isArray(arr) && arr.length && Array.isArray(arr[0].history)) hist = arr[0].history.slice();
  } catch (e) { console.warn('[koios] detail account_history failed:', e.message); }
  hist.sort((a, b) => (a.epoch_no || 0) - (b.epoch_no || 0));   // oldest first

  const runs = [];
  for (const h of hist) {
    const pool = h.pool_id_bech32 || h.pool_id || null;
    if (!pool) continue;
    const amt = h.active_stake != null ? Number(h.active_stake) / 1e6 : null;
    const ep = h.epoch_no;
    const last = runs[runs.length - 1];
    if (last && last.poolId === pool) { last.exitEpoch = ep; last.exitStake = amt; }
    else runs.push({ poolId: pool, entryEpoch: ep, entryStake: amt, exitEpoch: ep, exitStake: amt });
  }
  if (runs.length) runs[runs.length - 1].isCurrent = true;

  let cameFrom = null;
  const firstUsIdx = runs.findIndex((r) => r.poolId === _liveBech32);
  if (firstUsIdx > 0) cameFrom = runs[firstUsIdx - 1].poolId;

  return {
    stake,
    balance: info ? toAda(info.total_balance) : null,
    rewardsSum: info ? toAda(info.rewards) : null,
    withdrawalsSum: info ? toAda(info.withdrawals) : null,
    withdrawable: info ? toAda(info.rewards_available) : null,
    sinceEpoch: hist.length ? hist[0].epoch_no : (info && info.active_epoch_no != null ? Number(info.active_epoch_no) : null),
    drepId: info ? (info.delegated_drep || null) : null,
    currentPool: info ? (info.delegated_pool || null) : null,
    cameFrom,
    runs,
  };
}

export const koiosLiveDelegatorsSource = {
  id: 'koios-live',
  label: 'Koios',
  isCli: false,
  provides: () => (_liveReady ? [DataKind.DELEGATOR_LIST_LIVE, DataKind.POOL_LIVE, DataKind.DELEGATOR_LIST, DataKind.DELEGATOR_DETAIL] : []),
  reachable: () => _liveReady,
  version: () => null,
  get: async (kind, _params = {}) => {
    if (kind === DataKind.DELEGATOR_LIST) {
      if (!_liveBech32) return [];
      const rows = await getPoolDelegators(_liveBech32);
      return (rows || []).map((d) => ({
        stake: d.stake, liveStake: d.liveStake, liveStakeLovelace: d.liveStakeLovelace, isOwner: false,
      }));
    }
    if (kind === DataKind.DELEGATOR_DETAIL) {
      return getDelegatorDetail(_params.stake, _params.currentEpoch);
    }
    if (kind === DataKind.POOL_LIVE) {
      if (!_liveBech32) return null;
      const p = await getPoolInfo(_liveBech32);
      if (!p) return null;
      // Map Koios pool_info to the shared POOL_LIVE shape (matches Blockfrost).
      return {
        poolId: p.poolIdBech32,
        blocksMinted: p.blockCountLifetime != null ? Number(p.blockCountLifetime) : null,
        blocksEpoch: null,                       // not in pool_info; sourced elsewhere
        liveStake: p.liveStake,
        activeStake: p.activeStake,
        liveSaturation: p.liveSaturation != null ? Number(p.liveSaturation) : null,
        liveDelegators: p.liveDelegators != null ? Number(p.liveDelegators) : null,
        declaredPledge: p.pledge,
        livePledge: p.livePledge,
        margin: p.margin != null ? Number(p.margin) : null,
        fixedCost: p.fixedCost,
        rewardAccount: p.rewardAddr || null,
        owners: [],
        registrations: [],
      };
    }
    if (kind !== DataKind.DELEGATOR_LIST_LIVE) {
      throw new Error(`koios-live source can't provide ${kind}`);
    }
    if (!_liveBech32) return [];
    return getPoolDelegators(_liveBech32);
  },
};

/**
 * Arm the Koios live-delegators provider for a pool and register it into the
 * spine (idempotent). Trusts Koios reachability the way live block production
 * does — fetch failures degrade to [] rather than flipping reachability — so
 * there's no probe here; the wizard will add real per-source health checks.
 */
export function initKoiosLiveDelegators(poolBech32) {
  if (!poolBech32) return false;
  _liveBech32 = poolBech32;
  _liveReady = true;
  if (!registry.all().some((s) => s.id === 'koios-live')) {
    registry.register(koiosLiveDelegatorsSource);
  }
  return true;
}

/** Reset on disconnect / reconnect (mirrors the other sources' reset hooks). */
export function resetKoiosLiveDelegators() {
  _liveBech32 = null;
  _liveReady = false;
}
