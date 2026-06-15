/**
 * PoolTerminal — Live data source.
 *
 * Slot ↔ unix conversion is dynamic from the env probe so this works on
 * mainnet / preprod / preview without hardcoded constants.
 *
 * Cardano convention quirk: the variable named SHELLEY_GENESIS_START_SEC in
 * Guild env files (and in shelley-genesis.json itself) is actually the BYRON
 * genesis time, not the Shelley era start. Slot 0 is in Byron (20-second
 * slots); Shelley begins at slot BYRON_SLOTS after the Byron era.
 *
 * KES query is cached for 60s — periods change once every 1.5 days so
 * re-polling every snapshot would be wasteful. Only attempts the query
 * when the node-probe surfaced an opCertPath (i.e. we're connected to
 * a BP). Sets kesDaysRemaining/kesPeriodsRemaining to null on relays.
 *
 * Pulse score is a weighted sum of four real components:
 *   KES health (0-30) · Sync at tip (0-30) · Peers ≥1 (0-25) · Mempool (0-15)
 * Total max 100. Null when we have no data yet.
 */

import { invoke } from './tauri.js';
import { getSession } from './session.js';
import { getNodeProbe } from './session.js';
import { getLastMetrics } from './metrics-query.js';
import { queryHost, getLastHost } from './host-query.js';
import * as readModel from './read-model.js';

const BYRON_SLOT_LEN_S = 20;
const KES_REFRESH_S    = 60;
const HOST_SCRAPE_S    = 5;     // host /proc + df scrape cadence (rate deltas)

function envOf() { return getSession().envVars || {}; }

function slotAnchor() {
  const e = envOf();
  const byronStart = parseInt(e.SHELLEY_GENESIS_START_SEC, 10) || 1506203091;
  const transEpoch = parseInt(e.SHELLEY_TRANS_EPOCH, 10)        || 208;
  const byronEpLen = parseInt(e.BYRON_EPOCH_LENGTH, 10)         || 21600;
  const byronSlots = transEpoch * byronEpLen;
  const shelleyEraStart = byronStart + byronSlots * BYRON_SLOT_LEN_S;
  return { shelleyEraStart, byronSlots };
}

function slotToUnix(slot) {
  const { shelleyEraStart, byronSlots } = slotAnchor();
  return shelleyEraStart + (slot - byronSlots);
}
function unixToSlot(unix) {
  const { shelleyEraStart, byronSlots } = slotAnchor();
  return byronSlots + (unix - shelleyEraStart);
}
function nowSlot() { return unixToSlot(Math.floor(Date.now() / 1000)); }

async function runCmd(command) {
  const r = await invoke('ssh_run', { command });
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object') {
    if (typeof r.exit_code === 'number' && r.exit_code !== 0) {
      throw new Error(
        `ssh_run exit ${r.exit_code}: ${(r.stderr || r.stdout || '').slice(0, 400)}`
      );
    }
    return r.stdout ?? '';
  }
  return String(r);
}

function cliCmd(args) {
  const e = envOf();
  return `CARDANO_NODE_SOCKET_PATH=${e.CARDANO_NODE_SOCKET_PATH} ${e.CCLI} ${args} ${e.NETWORK_IDENTIFIER || '--mainnet'}`;
}

const ZERO_BP = { leader: 0, ideal: 0, luckPercent: 100, adopted: 0, confirmed: 0, lost: 0 };

// Expected blocks minted network-wide per epoch, at full decentralisation:
//   epoch_length (432000 slots) × active_slot_coeff (0.05) = 21600  (mainnet)
// A pool's Ideal = σ × this, where σ = poolStakeGo / totalStakeGo.
const EXPECTED_BLOCKS_PER_EPOCH = 21600;

function emptyChainPulse(tipBlock = 0) {
  return {
    sinceLastBlockSeconds: 0,
    atTip: false,
    tipBlock,
    recentBlockTimes: [],
    windowStats: { avgSeconds: 0, maxSeconds: 0, minSeconds: 0 },
    density: { m1: 0, m5: 0, m20: 0, h1: 0, d1: 0, epoch: 0 },
  };
}

function emptyMempool() {
  return { txCount: 0, totalBytes: 0, recent: [] };
}

function computePulse(snap) {
  let total = 0;
  const components = {};

  // KES health (0-30)
  if (snap.kesDaysRemaining != null) {
    if      (snap.kesDaysRemaining > 30) components.kes = 30;
    else if (snap.kesDaysRemaining > 14) components.kes = 20;
    else if (snap.kesDaysRemaining > 7)  components.kes = 10;
    else                                  components.kes = 0;
  } else {
    // No op.cert (relay) — neutral 25 so Pulse isn't penalised
    components.kes = 25;
  }
  total += components.kes;

  // Sync at tip (0-30)
  components.sync = snap.atTip ? 30 : (snap.syncPercent >= 95 ? 15 : 0);
  total += components.sync;

  // Peers (0-25)
  // Peers (0-25). In live mode the counts come from the Prometheus metrics
  // scrape, not the tip snapshot, so prefer those and fall back to the snap.
  const pm = getLastMetrics();
  const totalPeers = pm
    ? (pm.outgoingConns || 0) + (pm.incomingConns || 0)
    : (snap.peersIn || 0) + (snap.peersOut || 0);
  components.peers = totalPeers >= 1 ? 25 : 0;
  total += components.peers;

  // Mempool reachable (0-15) — proxy for "node is responsive"
  const m = getLastMetrics();
  components.mempool = m ? 15 : 0;
  total += components.mempool;

  return { score: total, components };
}

export class LiveDataSource {
  constructor() {
    this.mode = 'live';
    this._lastTip = null;
    this._kesDays = null;
    this._kesPeriods = null;
    this._kesExpiryMs = null;
    this._kesAt = 0;
    this._lastPulseScore = null;

    // Ideal blocks — computed once per epoch from cardano-cli stake-snapshot.
    // stakeGo is frozen for the epoch, so this only changes on epoch rollover.
    this._ideal = null;
    this._idealEpoch = null;
    this._idealInFlight = false;
    this._hostAt = 0;
    this._healthInFlight = false;

    // Fresh read-model state per connection (backfill flag, throttles, caches).
    readModel.resetReadModel();
  }

  async getPoolIdentity() {
    const e = envOf();
    return {
      ticker: e.POOL_TICKER || e.POOL_NAME || 'POOL',
      poolId: '',
      poolIdHex: e.POOL_ID || '',
    };
  }

  /**
   * Ideal blocks for the current epoch — computed entirely from cardano-cli,
   * no cncli. Ideal = σ × EXPECTED_BLOCKS_PER_EPOCH, σ = poolStakeGo / totalStakeGo.
   *
   * "Go" is the snapshot frozen at the start of THIS epoch — the stake that
   * governs block production right now (stakeSet = next epoch, stakeMark = two
   * epochs out). It is constant within an epoch, so we compute once and cache
   * in memory, recomputing only when the epoch changes.
   *
   * Note: totalStakeGo (~2.17e16) exceeds JS's safe-integer range (2^53 ≈
   * 9.0e15), so JSON.parse rounds it by ~1 lovelace. That's a relative error
   * of ~5e-17 — utterly irrelevant to a value we display to 2 decimal places.
   */
  async _maybeRefreshIdeal(epoch) {
    if (this._idealInFlight) return;
    if (this._idealEpoch === epoch) return;   // already computed this epoch

    const e = envOf();
    if (!e.POOL_ID) {
      this._ideal = null;
      this._idealEpoch = epoch;
      return;
    }

    this._idealInFlight = true;
    try {
      const out = await runCmd(cliCmd(`query stake-snapshot --stake-pool-id ${e.POOL_ID}`));
      const jsonStart = out.indexOf('{');
      if (jsonStart < 0) throw new Error('no JSON in stake-snapshot output');
      const json = JSON.parse(out.slice(jsonStart));

      // cardano-node 11.0.1 nested format first; fall back to legacy flat keys.
      const poolGo  = json.pools?.[e.POOL_ID]?.stakeGo ?? json.poolStakeGo;
      const totalGo = json.total?.stakeGo              ?? json.activeStakeGo;
      if (poolGo == null || totalGo == null || totalGo === 0) {
        throw new Error(`missing stakeGo (pool=${poolGo} total=${totalGo})`);
      }

      const sigma = poolGo / totalGo;
      this._ideal = Math.round(sigma * EXPECTED_BLOCKS_PER_EPOCH * 100) / 100;
      this._idealEpoch = epoch;
      console.log(`[live.ideal] epoch ${epoch}: σ=${sigma.toExponential(3)} ideal=${this._ideal}`);
    } catch (err) {
      console.warn('[live.ideal] failed:', err.message);
      this._ideal = null;
      this._idealEpoch = epoch;   // mark attempted; wait for next epoch, no retry-storm
    } finally {
      this._idealInFlight = false;
    }
  }

  async _maybeSampleHealth() {
    const now = Date.now();
    if (this._healthInFlight) return;
    if (this._hostAt && now - this._hostAt < HOST_SCRAPE_S * 1000) {
      // Between host scrapes: still let the sampler persist (it self-throttles).
      readModel.sampleHealth(getLastHost(), getLastMetrics());
      return;
    }
    this._healthInFlight = true;
    this._hostAt = now;
    try {
      const host = await queryHost();                 // CPU%, RAM, disk, net rate, load
      readModel.sampleHealth(host, getLastMetrics()); // persist (throttled ~30s)
    } catch (err) {
      console.warn('[live.health] scrape failed:', err.message);
    } finally {
      this._healthInFlight = false;
    }
  }

  async _maybeRefreshKes() {
    const now = Date.now() / 1000;
    if (now - this._kesAt < KES_REFRESH_S) return;

    const probe = getNodeProbe();
    if (!probe?.opCertPath) {
      this._kesDays    = null;
      this._kesPeriods = null;
      this._kesAt      = now;
      return;
    }

    const cmd = cliCmd(`query kes-period-info --op-cert-file '${probe.opCertPath}'`);
    try {
      const out  = await runCmd(cmd);
      // cardano-cli emits checkmark validation lines BEFORE the JSON; skip
      // everything up to the first '{' before parsing.
      const jsonStart = out.indexOf('{');
      if (jsonStart < 0) throw new Error('no JSON object in kes-period-info output');
      const info = JSON.parse(out.slice(jsonStart));
      const cur  = info.qKesCurrentKesPeriod;
      const end  = info.qKesEndKesInterval;
      this._kesPeriods = Math.max(0, end - cur);

      this._kesExpiryMs = null;
      if (info.qKesKesKeyExpiry) {
        const expiryMs = Date.parse(info.qKesKesKeyExpiry);
        if (expiryMs > 0) {
          this._kesExpiryMs = expiryMs;
          this._kesDays = Math.max(0, Math.floor((expiryMs - Date.now()) / 86400000));
        }
      }
      if (this._kesDays == null) {
        const slotsPerKes = info.qKesSlotsPerKesPeriod || 129600;
        this._kesDays = Math.floor((this._kesPeriods * slotsPerKes) / 86400);
        // Approximate expiry from periods if cli didn't give us a timestamp
        if (this._kesPeriods > 0) {
          this._kesExpiryMs = Date.now() + this._kesPeriods * slotsPerKes * 1000;
        }
      }
      console.log(`[live.kes] periods=${this._kesPeriods} days=${this._kesDays}`);
    } catch (err) {
      console.warn('[live.kes] query failed:', err.message);
      this._kesDays     = null;
      this._kesPeriods  = null;
      this._kesExpiryMs = null;
    }
    this._kesAt = now;
  }

  async getNowSnapshot() {
    const out = await runCmd(cliCmd('query tip'));
    const tip = JSON.parse(out);
    const epochLen = (tip.slotInEpoch || 0) + (tip.slotsToEpochEnd || 0);
    const progress = epochLen > 0 ? (tip.slotInEpoch || 0) / epochLen : 0;
    const sync     = parseFloat(tip.syncProgress || '0');
    this._lastTip  = tip;
    const e = envOf();

    // KES refresh runs in the background; doesn't gate the snapshot.
    this._maybeRefreshKes();
    // Ideal refresh — also background, fire-and-forget, once per epoch.
    this._maybeRefreshIdeal(tip.epoch);

    // Read-model collectors — all fire-and-forget, internally throttled:
    //   backfill (once), semi-live samples (~3 min), block production (per epoch).
    readModel.backfillIfNeeded();
    readModel.refreshIdealFiller();
    readModel.refreshRecent(tip.epoch);
    readModel.refreshSemiLive();
    readModel.refreshBlockProduction(tip.epoch, this._ideal);
    readModel.refreshHistory(tip.epoch);   // db-sync (or Koios) history population
    readModel.refreshNotifications(tip.epoch);   // live delegator-change feed (~5 min)

    // NODE HEALTH — node-direct, never Koios. Host scrape on a slow cadence
    // (~5s; rate deltas computed there), then persist host + node metrics to the
    // samples table (sampler self-throttles to ~30s). Fire-and-forget.
    this._maybeSampleHealth();

    // Build snap with KES + everything else needed for Pulse
    const snap = {
      poolTicker:        e.POOL_TICKER || e.POOL_NAME || 'POOL',
      network:           e.NETWORK_NAME || (e.NETWORK_IDENTIFIER || '').replace(/^--/, '') || 'Mainnet',
      era:               tip.era || '',
      epoch:             tip.epoch,
      epochProgress:     progress,
      epochLength:       epochLen,
      slot:              tip.slot,
      slotInEpoch:       tip.slotInEpoch || 0,
      tipBlock:          tip.block,
      syncPercent:       sync,
      atTip:             sync >= 99.95,
      kesDaysRemaining:    this._kesDays,
      kesPeriodsRemaining: this._kesPeriods,
      kesKeyExpiryUnix:    this._kesExpiryMs ? Math.floor(this._kesExpiryMs / 1000) : null,
      peersIn:  null,
      peersOut: null,
      blockProduction: readModel.currentBlockProduction() || { ...ZERO_BP, ideal: this._ideal ?? 0 },
    };

    // Pulse formula — computed last from the fields above
    const pulse = computePulse(snap);
    const delta = this._lastPulseScore == null ? 0 : pulse.score - this._lastPulseScore;
    this._lastPulseScore = pulse.score;
    snap.poolPulse = { score: pulse.score, delta, components: pulse.components };

    return snap;
  }

  async getUpcomingBlocks() {
    // Leader schedule is a BP-only concept — relays never produce blocks and
    // have no pool keys. Return empty immediately so a relay never shows the
    // BP's slots (the per-epoch poolterminal.db cache is node-agnostic, so we
    // must gate here rather than rely on the cache being clear).
    const role = getNodeProbe()?.role;
    const isBP = typeof role === 'string' && role.toLowerCase() === 'bp';
    if (!isBP) return [];
    const epoch = this._lastTip?.epoch ?? null;
    const slots = await readModel.getUpcomingBlocks(epoch);   // [{slot,time,epoch,when}]
    const nowSec = Math.floor(Date.now() / 1000);
    return slots.map((s, i) => ({
      index:       i + 1,
      slot:        s.slot,
      epoch:       s.epoch,
      nextEpoch:   epoch != null && s.epoch === epoch + 1,
      atTimestamp: Math.floor(s.when / 1000),
      etaSeconds:  Math.max(0, Math.floor(s.when / 1000) - nowSec),
    }));
  }

  async getChainPulse() {
    const t0 = performance.now();
    try {
      const e = envOf();
      if (!e.CNCLI_DB) throw new Error('No CNCLI_DB path');
      const slotCutoff = nowSlot() - 3700;
      const cmd =
        `sqlite3 ${e.CNCLI_DB} ` +
        `"SELECT slot_number FROM chain ` +
        `WHERE orphaned = 0 AND slot_number > ${slotCutoff} ORDER BY slot_number ASC"`;
      const out = await runCmd(cmd);

      const slots = out.trim().split('\n').filter(Boolean).map(Number).filter(n => Number.isFinite(n));
      const times = slots.map(slotToUnix);
      const now = Math.floor(Date.now() / 1000);
      const latestSlot = slots.length ? slots[slots.length - 1] : null;
      const ageOfLatest = latestSlot != null ? now - slotToUnix(latestSlot) : null;

      console.log(
        `[live.getChainPulse] ${Math.round(performance.now() - t0)}ms · ` +
        `${slots.length} rows · latest_slot=${latestSlot} · age=${ageOfLatest}s`
      );

      const sinceLast = times.length ? now - times[times.length - 1] : 0;
      const gaps = [];
      for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
      const avg = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
      const max = gaps.length ? Math.max(...gaps) : 0;
      const min = gaps.length ? Math.min(...gaps) : 0;
      const countWithin = (w) => times.filter((t) => now - t <= w).length;

      return {
        sinceLastBlockSeconds: sinceLast,
        atTip: true,
        tipBlock: this._lastTip?.block || 0,
        recentBlockTimes: times,
        windowStats: { avgSeconds: avg, maxSeconds: max, minSeconds: min },
        density: {
          m1:  countWithin(60)   / 60,
          m5:  countWithin(300)  / 300,
          m20: countWithin(1200) / 1200,
          h1:  times.length      / 3600,
          d1:  0.05,
          epoch: 0.05,
        },
      };
    } catch (err) {
      console.warn(`[live.getChainPulse] FAIL in ${Math.round(performance.now() - t0)}ms:`, err.message);
      return emptyChainPulse(this._lastTip?.block || 0);
    }
  }

  async getMempool() {
    const t0 = performance.now();
    try {
      const out = await runCmd(cliCmd('query tx-mempool info'));
      const info = JSON.parse(out);
      const totalBytes = info.sizeInBytes ?? info.bytes ?? 0;
      console.log(
        `[live.getMempool] ${Math.round(performance.now() - t0)}ms · ` +
        `${info.numberOfTxs ?? 0} tx · ${totalBytes} bytes`
      );
      return {
        txCount:    info.numberOfTxs ?? 0,
        totalBytes,
        recent:     [],
      };
    } catch (err) {
      console.warn(`[live.getMempool] FAIL in ${Math.round(performance.now() - t0)}ms:`, err.message);
      return emptyMempool();
    }
  }
}
