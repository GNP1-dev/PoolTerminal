/**
 * PoolTerminal — DEMO1 synthetic data source.
 *
 * Implements the full DataSource contract with believable synthetic data for the
 * "DEMO1" pool. Lets us develop/screenshot the whole UI without a live node.
 *
 * Realism:
 *  - epoch / slot / progress anchored to the REAL Cardano epoch clock
 *  - Praos-like exponential inter-block gaps
 *  - block production accrues as the epoch progresses
 *  - chain pulse is STATEFUL: block arrivals have fixed times that persist across
 *    calls (drift left, fall off at 5 min), so the heartbeat scrolls correctly
 */

import './contract.js';

const SHELLEY_START = 1596491091; // unix ts, start of Shelley epoch 208
const SHELLEY_EPOCH = 208;        // Shelley began at epoch 208, not 0
const BYRON_SLOTS = 4492800;      // Byron slots before Shelley (for abs slot)
const EPOCH_LEN = 432000;         // seconds per epoch (5 days)

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

// Exponential gap with given mean — Praos-like inter-block spacing.
function expGap(meanSec) {
  return -meanSec * Math.log(1 - Math.random());
}

// Stable pseudo-random 0..1 per epoch so values don't jump on every poll.
function epochSeed(epoch) {
  const x = Math.sin(epoch * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function realEpoch() {
  const elapsed = nowSec() - SHELLEY_START;
  const epoch = SHELLEY_EPOCH + Math.floor(elapsed / EPOCH_LEN);
  const slotInEpoch = elapsed % EPOCH_LEN;
  return {
    epoch,
    slotInEpoch,
    progress: slotInEpoch / EPOCH_LEN,
    absSlot: BYRON_SLOTS + elapsed,
  };
}

export class DemoDataSource {
  constructor() {
    this.mode = 'demo';
    this._chain = null; // stateful block-arrival stream for the heartbeat
  }

  async getPoolIdentity() {
    return {
      ticker: 'DEMO1',
      poolId: 'pool1demo0000000000000000000000000000000000000000000000000',
      poolIdHex: '00000000000000000000000000000000000000000000000000000000',
    };
  }

  async getNowSnapshot() {
    const e = realEpoch();
    const seed = epochSeed(e.epoch);
    const leader = 18 + Math.floor(seed * 6);
    const ideal = leader / (0.93 + seed * 0.12);
    const luckPercent = Math.round((leader / ideal) * 100);
    const adopted = Math.min(leader, Math.round(leader * e.progress));
    const pulseScore = 90 + Math.round(4 * Math.sin(nowSec() / 600) + 2);

    return {
      poolTicker: 'DEMO1',
      epoch: e.epoch,
      epochProgress: e.progress,
      slot: e.absSlot,
      slotInEpoch: e.slotInEpoch,
      syncPercent: 100.0,
      atTip: true,
      kesDaysRemaining: 47,
      kesPeriodsRemaining: 34,
      peersIn: 8 + Math.floor(Math.random() * 4),
      peersOut: 12,
      forging: true,
      blockProduction: {
        leader,
        ideal: Math.round(ideal * 10) / 10,
        luckPercent,
        adopted,
        confirmed: adopted,
        lost: 0,
      },
      poolPulse: {
        score: pulseScore,
        delta: 2,
        components: {
          blockPerformance: 92, propagation: 88, uptime: 100, kes: 52,
          peers: 100, delegatorStability: 95, saturationHeadroom: 80, pledge: 100,
        },
      },
    };
  }

  async getUpcomingBlocks() {
    const e = realEpoch();
    const seed = epochSeed(e.epoch);
    const leader = 18 + Math.floor(seed * 6);
    const adopted = Math.min(leader, Math.round(leader * e.progress));
    const remaining = Math.max(0, leader - adopted);
    const slotsLeft = EPOCH_LEN - e.slotInEpoch;

    const blocks = [];
    let cursor = 0;
    for (let i = 0; i < remaining; i++) {
      cursor += slotsLeft / (remaining + 1);
      const eta = Math.max(
        1,
        Math.floor(cursor + (Math.random() - 0.5) * (slotsLeft / (remaining + 2)))
      );
      blocks.push({ index: 0, slot: e.absSlot + eta, etaSeconds: eta });
    }
    blocks.sort((a, b) => a.etaSeconds - b.etaSeconds);
    blocks.forEach((b, i) => (b.index = i + 1));
    return blocks;
  }

  async getChainPulse() {
    const now = nowSec();

    // Seed the stream the first time: fill the last 5 min with arrivals.
    if (!this._chain) {
      const times = [];
      let t = now - Math.floor(expGap(20));
      while (t > now - 300) {
        times.push(t);
        t -= Math.floor(expGap(20)) + 1;
      }
      times.reverse();
      const last = times.length ? times[times.length - 1] : now - 20;
      this._chain = { times, nextAt: last + Math.floor(expGap(20)) + 1 };
    }

    // Advance: realise any block arrivals scheduled since the last call.
    while (this._chain.nextAt <= now) {
      this._chain.times.push(this._chain.nextAt);
      this._chain.nextAt += Math.floor(expGap(20)) + 1;
    }
    // Keep a little beyond the 5-min window for stable stats.
    this._chain.times = this._chain.times.filter((t) => t > now - 320);

    const times = this._chain.times;
    const sinceLast = times.length ? now - times[times.length - 1] : now;
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    const avg = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
    const max = gaps.length ? Math.max(...gaps) : 0;
    const min = gaps.length ? Math.min(...gaps) : 0;
    const jitter = () => Math.round((0.05 + (Math.random() - 0.5) * 0.004) * 1000) / 1000;

    return {
      sinceLastBlockSeconds: sinceLast,
      atTip: true,
      tipBlock: 11427892 + Math.floor((now - SHELLEY_START) / 20),
      recentBlockTimes: times.slice(),
      windowStats: { avgSeconds: avg, maxSeconds: max, minSeconds: min },
      density: { m5: jitter(), h1: jitter(), h24: 0.05, d7: 0.05, epoch: 0.05 },
    };
  }

  async getMempool() {
    const n = Math.floor(Math.random() * 6);
    const recent = [];
    let total = 0;
    for (let i = 0; i < n; i++) {
      const bytes = 300 + Math.floor(Math.random() * 1200);
      total += bytes;
      recent.push({ hash: Math.random().toString(16).slice(2, 6) + '…', bytes });
    }
    return { txCount: n, totalBytes: total, recent };
  }
}
