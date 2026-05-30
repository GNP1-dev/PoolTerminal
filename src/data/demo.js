/**
 * PoolTerminal — DEMO1 synthetic data source.
 *
 * Stateful pieces (so the UI looks coherent across polls):
 *  - Chain stream: keeps the last ~1 hour of block arrivals; heartbeat tabs
 *    select sub-windows.
 *  - Mempool: txs accumulate over time at a baseline rate, with occasional
 *    surges (NFT-mint / sweep style). Drains when the chain mints a block
 *    (one block worth ≈ 90 KiB removed FIFO). Lets the new mempool gauge
 *    visibly climb and step down in sync with the heartbeat.
 */

import './contract.js';

const SHELLEY_START = 1596491091;
const SHELLEY_EPOCH = 208;
const BYRON_SLOTS = 4492800;
const EPOCH_LEN = 432000;
const MAX_BLOCK_BODY = 90112; // bytes; matches mainnet maxBlockBodySize

function nowSec() { return Math.floor(Date.now() / 1000); }
function expGap(meanSec) { return -meanSec * Math.log(1 - Math.random()); }
function epochSeed(epoch) {
  const x = Math.sin(epoch * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}
function realEpoch() {
  const elapsed = nowSec() - SHELLEY_START;
  const epoch = SHELLEY_EPOCH + Math.floor(elapsed / EPOCH_LEN);
  const slotInEpoch = elapsed % EPOCH_LEN;
  return { epoch, slotInEpoch, progress: slotInEpoch / EPOCH_LEN, absSlot: BYRON_SLOTS + elapsed };
}
function rndHash() { return Math.random().toString(16).slice(2, 6) + '…'; }

export class DemoDataSource {
  constructor() {
    this.mode = 'demo';
    this._chain = null;
    this._mempool = null;
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
      epoch: e.epoch, epochProgress: e.progress,
      slot: e.absSlot, slotInEpoch: e.slotInEpoch,
      syncPercent: 100.0, atTip: true,
      kesDaysRemaining: 47, kesPeriodsRemaining: 34,
      peersIn: 8 + Math.floor(Math.random() * 4), peersOut: 12,
      forging: true,
      blockProduction: {
        leader, ideal: Math.round(ideal * 10) / 10, luckPercent,
        adopted, confirmed: adopted, lost: 0,
      },
      poolPulse: {
        score: pulseScore, delta: 2,
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
      const eta = Math.max(1, Math.floor(cursor + (Math.random() - 0.5) * (slotsLeft / (remaining + 2))));
      blocks.push({ index: 0, slot: e.absSlot + eta, etaSeconds: eta });
    }
    blocks.sort((a, b) => a.etaSeconds - b.etaSeconds);
    blocks.forEach((b, i) => (b.index = i + 1));
    return blocks;
  }

  async getChainPulse() {
    const now = nowSec();
    if (!this._chain) {
      const times = [];
      let t = now - Math.floor(expGap(20));
      while (t > now - 3600) {
        times.push(t);
        t -= Math.floor(expGap(20)) + 1;
      }
      times.reverse();
      const last = times.length ? times[times.length - 1] : now - 20;
      this._chain = { times, nextAt: last + Math.floor(expGap(20)) + 1 };
    }
    while (this._chain.nextAt <= now) {
      this._chain.times.push(this._chain.nextAt);
      this._chain.nextAt += Math.floor(expGap(20)) + 1;
    }
    this._chain.times = this._chain.times.filter((t) => t > now - 3700);

    const times = this._chain.times;
    const sinceLast = times.length ? now - times[times.length - 1] : now;
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    const avg = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 0;
    const max = gaps.length ? Math.max(...gaps) : 0;
    const min = gaps.length ? Math.min(...gaps) : 0;

    const countWithin = (w) => times.filter((t) => now - t <= w).length;
    const m1  = countWithin(60)   / 60;
    const m5  = countWithin(300)  / 300;
    const m20 = countWithin(1200) / 1200;
    const h1  = times.length / 3600;
    const d1  = 0.05 + (Math.random() - 0.5) * 0.0008;
    const epoch = 0.05;

    return {
      sinceLastBlockSeconds: sinceLast,
      atTip: true,
      tipBlock: 11427892 + Math.floor((now - SHELLEY_START) / 20),
      recentBlockTimes: times.slice(),
      windowStats: { avgSeconds: avg, maxSeconds: max, minSeconds: min },
      density: { m1, m5, m20, h1, d1, epoch },
    };
  }

  async getMempool() {
    if (!this._mempool) {
      this._mempool = { txs: [], lastChainLength: 0 };
    }

    // Drain by however many blocks the chain has minted since the last call.
    if (this._chain) {
      const len = this._chain.times.length;
      const newBlocks = len - this._mempool.lastChainLength;
      if (newBlocks > 0) {
        let toDrain = newBlocks * MAX_BLOCK_BODY;
        while (toDrain > 0 && this._mempool.txs.length > 0) {
          const tx = this._mempool.txs.shift();
          toDrain -= tx.bytes;
        }
        this._mempool.lastChainLength = len;
      }
    }

    // Baseline accumulation: 0-3 small txs per poll (~1.5/s avg).
    const baselineCount = Math.floor(Math.random() * 4);
    for (let i = 0; i < baselineCount; i++) {
      const bytes = 200 + Math.floor(Math.random() * 1500);
      this._mempool.txs.push({ hash: rndHash(), bytes });
    }

    // Occasional surge (~1.5% of polls): 150-350 KB blast (NFT mint, sweep…)
    if (Math.random() < 0.015) {
      const surgeBytes = 150000 + Math.floor(Math.random() * 200000);
      let added = 0;
      while (added < surgeBytes) {
        const bytes = 800 + Math.floor(Math.random() * 1500);
        this._mempool.txs.push({ hash: rndHash(), bytes });
        added += bytes;
      }
    }

    // Memory safety cap (extreme runaway protection)
    if (this._mempool.txs.length > 1500) {
      this._mempool.txs = this._mempool.txs.slice(-1500);
    }

    const totalBytes = this._mempool.txs.reduce((s, t) => s + t.bytes, 0);
    const recent = this._mempool.txs.slice(-20).reverse();
    return { txCount: this._mempool.txs.length, totalBytes, recent };
  }
}
