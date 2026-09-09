/*demo-world-v99*/
/**
 * PoolTerminal — DEMO synthetic world.
 *
 * One deterministic, epoch-anchored synthetic pool (DEMO1) behind EVERY tab in
 * demo mode. HARD RULE: while demo is active the app touches nothing real —
 * no SSH, no Postgres, no Koios/Blockfrost/geo APIs, no reads of the SQLite
 * cache a live session wrote. Every number, address, hash, IP and timestamp
 * on screen comes from here (plus demo.js, which delegates to this module for
 * anything the other tabs also show, so tabs can never disagree).
 *
 * Determinism: a fixed-seed PRNG (mulberry32) keyed by epoch number — the same
 * demo looks the same on every launch within an epoch, so screenshots are
 * reproducible and support questions answerable. Math.random appears nowhere
 * in this file.
 *
 * Obviously synthetic on inspection:
 *  - stake addresses are REAL bech32 (valid checksum, correct length) over
 *    fabricated key hashes — an explorer parses them fine and finds nothing.
 *  - tx hashes are deterministic hex that exists on no chain.
 *  - peer IPs come from the RFC 5737 documentation ranges (192.0.2.0/24,
 *    198.51.100.0/24, 203.0.113.0/24), which cannot route to a real host.
 *
 * Plausible, not flattering: luck wanders ~70–140%, blocks get lost now and
 * then, two early epochs produced nothing, one delegator defected, one took a
 * big withdrawal, and the delegator list has whales, a mid-field and dust.
 */

// ---- deterministic PRNG ----------------------------------------------------

const WORLD_SEED = 0x6de01;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Deterministic stream keyed by (label, n). */
function rng(label, n = 0) {
  let h = WORLD_SEED;
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 2654435761);
  return mulberry32((h ^ Math.imul(n + 1, 0x9E3779B1)) >>> 0);
}

// ---- bech32 (BIP-173) ------------------------------------------------------

const B32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function b32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function b32HrpExpand(hrp) {
  const out = [];
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
  out.push(0);
  for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
  return out;
}
function b32Convert(bytes) {   // 8-bit -> 5-bit groups
  const out = [];
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}
function bech32Encode(hrp, bytes) {
  const data = b32Convert(bytes);
  const values = b32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = b32Polymod(values) ^ 1;
  const chk = [];
  for (let i = 0; i < 6; i++) chk.push((mod >> (5 * (5 - i))) & 31);
  return hrp + '1' + data.concat(chk).map((v) => B32[v]).join('');
}

/** Valid-checksum mainnet stake address over a fabricated 28-byte hash. */
function demoStakeAddr(n) {
  const r = rng('stakeaddr', n);
  const bytes = [0xe1];                       // mainnet, stake key hash
  for (let i = 0; i < 28; i++) bytes.push(Math.floor(r() * 256));
  return bech32Encode('stake', bytes);
}
/** Deterministic 64-char hex tx hash that exists on no chain. */
export function demoTxHash(label, n = 0) {
  const r = rng('tx:' + label, n);
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(r() * 256).toString(16).padStart(2, '0');
  return s;
}

// ---- epoch clock (same anchor demo.js uses) --------------------------------

const SHELLEY_START = 1596491091;
const SHELLEY_EPOCH = 208;
const BYRON_SLOTS = 4492800;
const EPOCH_LEN = 432000;

function nowSec() { return Math.floor(Date.now() / 1000); }
export function demoClock() {
  const elapsed = nowSec() - SHELLEY_START;
  const epoch = SHELLEY_EPOCH + Math.floor(elapsed / EPOCH_LEN);
  const slotInEpoch = elapsed % EPOCH_LEN;
  return {
    epoch, slotInEpoch,
    progress: slotInEpoch / EPOCH_LEN,
    absSlot: BYRON_SLOTS + elapsed,
    tipBlock: Math.floor(elapsed / 20),
  };
}

// ---- the pool's life story -------------------------------------------------

const POOL_AGE = 211;                    // epochs since first registration
const NET_STAKE_ADA = 21_900_000_000;    // network active stake (fixed, plausible)
const EXPECTED_BLOCKS = 21600;           // per epoch, network-wide
const PLEDGE_ADA = 250_000;
const FIXED_COST = 170;
const MARGIN = 0.02;

/** Active stake (ADA) at epoch e — a growth ramp with seeded wobble. */
function stakeAt(e, firstEpoch) {
  const t = Math.min(1, Math.max(0, (e - firstEpoch) / (POOL_AGE - 12)));
  const base = 5_500_000 + (21_400_000 - 5_500_000) * Math.pow(t, 1.35);
  const wob = (rng('stake', e)() - 0.5) * 0.05;
  return Math.round(base * (1 + wob));
}
function delegatorCountAt(e, firstEpoch) {
  const t = Math.min(1, Math.max(0, (e - firstEpoch) / (POOL_AGE - 8)));
  return Math.round(23 + (108 - 23) * Math.pow(t, 1.2) + (rng('dcount', e)() - 0.5) * 4);
}

/** One epoch's production row. Deterministic per epoch. */
function epochRow(e, firstEpoch) {
  const stake = stakeAt(e, firstEpoch);
  const ideal = (stake / NET_STAKE_ADA) * EXPECTED_BLOCKS;
  const r = rng('epoch', e);
  // leader assignment: ideal + seeded noise ~ sqrt(ideal) (Poisson-ish spread)
  let leader = Math.max(0, Math.round(ideal + (r() + r() + r() - 1.5) * Math.sqrt(ideal) * 1.4));
  // two genuinely blockless epochs early in the pool's life
  if (e === firstEpoch + 3 || e === firstEpoch + 7) leader = 0;
  // an occasional lost block (~1 in 15 epochs), never flattered away
  const lost = (leader > 0 && (e % 15) === 4) ? 1 : 0;
  const adopted = Math.max(0, leader - lost);
  const member = adopted > 0 ? Math.round(stake * 0.0272 / 73 * (adopted / Math.max(ideal, 0.1))) : 0;
  const leaderRw = adopted > 0 ? Math.round(FIXED_COST + member * MARGIN / (1 - MARGIN) + PLEDGE_ADA * 0.0272 / 73) : 0;
  return {
    epoch: e,
    leader, adopted, lost,
    ideal: Math.round(ideal * 100) / 100,
    activeStake: stake,
    delegators: delegatorCountAt(e, firstEpoch),
    memberRewards: member,
    leaderReward: leaderRw,
    margin: MARGIN, fixedCost: FIXED_COST,
    source: 'demo',
  };
}

// ---- world (memoized per epoch) --------------------------------------------

let _world = null;

export function demoWorld() {
  const clock = demoClock();
  if (_world && _world.epoch === clock.epoch) return _world;

  const epoch = clock.epoch;
  const firstEpoch = epoch - POOL_AGE + 1;

  // History: every epoch of the pool's life, oldest first.
  const history = [];
  for (let e = firstEpoch; e <= epoch; e++) history.push(epochRow(e, firstEpoch));
  const lifetimeBlocks = history.reduce((s, r) => s + r.adopted, 0);
  const cur = history[history.length - 1];

  // ---- delegators: pledge + 2 whales + mid-field + dust tail, summing to
  // the current active stake. Tenure/joins are deterministic per index.
  const target = cur.activeStake - PLEDGE_ADA;
  const entries = [];
  const whales = [Math.round(target * 0.243), Math.round(target * 0.145)];
  whales.forEach((w, i) => entries.push({ n: 900 + i, stake: w }));
  const nMid = 34, nSmall = 48, nDust = 22;
  let acc = whales[0] + whales[1];
  const midR = rng('mid');
  for (let i = 0; i < nMid; i++) {
    const s = Math.round(target * 0.52 / nMid * (0.35 + midR() * 1.3));
    entries.push({ n: 100 + i, stake: s }); acc += s;
  }
  const smR = rng('small');
  for (let i = 0; i < nSmall; i++) {
    const s = Math.round(1200 + smR() * 22000);
    entries.push({ n: 300 + i, stake: s }); acc += s;
  }
  const duR = rng('dust');
  for (let i = 0; i < nDust; i++) {
    const s = Math.round(2 + duR() * 480);
    entries.push({ n: 500 + i, stake: s }); acc += s;
  }
  // scale the mid-field so the sum lands on the active stake exactly-ish
  const scale = (target - whales[0] - whales[1]) / (acc - whales[0] - whales[1]);
  entries.forEach((d) => { if (d.n < 900) d.stake = Math.max(2, Math.round(d.stake * scale)); });

  const delegators = entries.map((d, i) => {
    const stake = demoStakeAddr(d.n);
    const joinR = rng('join', d.n);
    // whales joined mid-life, dust drifts in late, the mid-field spans the range
    let sinceEpoch;
    if (d.n >= 900) sinceEpoch = firstEpoch + 40 + Math.floor(joinR() * 60);
    else if (d.n >= 500) sinceEpoch = epoch - 2 - Math.floor(joinR() * 60);
    else sinceEpoch = firstEpoch + 2 + Math.floor(joinR() * (POOL_AGE - 30));
    const tenure = epoch - sinceEpoch;
    return {
      stake,
      liveStake: d.stake,
      liveStakeLovelace: d.stake * 1_000_000,
      isOwner: false,
      stakeBasis: 'snapshot',
      basisEpoch: epoch,
      tenure, sinceEpoch, curStake: d.stake,
      // one defector, one big-withdrawal penalty — a real pool has scars
      defected: i === 11,
      defectToPool: i === 11 ? 'pool1demoothrpoolxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' : null,
      defectEpoch: i === 11 ? epoch - 31 : null,
      defectToAda: i === 11 ? 41_000 : null,
      reductionFactor: i === 23 ? 0.62 : 0,
    };
  });
  // the operator's pledge address
  delegators.unshift({
    stake: demoStakeAddr(1),
    liveStake: PLEDGE_ADA + 1_450, liveStakeLovelace: (PLEDGE_ADA + 1_450) * 1_000_000,
    isOwner: true, stakeBasis: 'snapshot', basisEpoch: epoch,
    tenure: POOL_AGE - 1, sinceEpoch: firstEpoch, curStake: PLEDGE_ADA + 1_450,
    defected: false, defectToPool: null, defectEpoch: null, defectToAda: null, reductionFactor: 0,
  });
  delegators.sort((a, b) => b.liveStakeLovelace - a.liveStakeLovelace);

  // ---- pending joiners (0.3.2): visible immediately, active in epoch+2
  const pending = [
    { stake: demoStakeAddr(970), liveStake: 84_620, liveStakeLovelace: 84_620_000_000,
      isOwner: false, stakeBasis: 'live', basisEpoch: null, pending: true, activeEpochNo: epoch + 2 },
    { stake: demoStakeAddr(971), liveStake: 318, liveStakeLovelace: 318_000_000,
      isOwner: false, stakeBasis: 'live', basisEpoch: null, pending: true, activeEpochNo: epoch + 2 },
  ];

  _world = {
    epoch, firstEpoch, clock, history, lifetimeBlocks,
    cur, delegators, pending,
    liveStake: cur.activeStake + 96_400,     // live runs slightly ahead of the snapshot
    activeStake: cur.activeStake,
    pledge: PLEDGE_ADA,
  };
  return _world;
}

// ---- capability-registry source --------------------------------------------

function poolLive() {
  const w = demoWorld();
  return {
    liveStake: w.liveStake,
    activeStake: w.activeStake,
    liveDelegators: w.delegators.length + w.pending.length,
    livePledge: w.pledge + 1_450,
    declaredPledge: w.pledge,
    liveSaturation: w.liveStake / 75_500_000,
    blockCountLifetime: w.lifetimeBlocks,
  };
}

function delegatorDetail(stake) {
  const w = demoWorld();
  const d = w.delegators.find((x) => x.stake === stake) || w.pending.find((x) => x.stake === stake);
  if (!d) return null;
  const rewardsSum = Math.round((d.tenure || 0) * (d.curStake || d.liveStake) * 0.0272 / 73);
  const withdrawable = Math.round(rewardsSum * 0.07);
  return {
    stake,
    snapshotEpoch: d.pending ? null : w.epoch,
    nextEpoch: w.epoch + 1,
    nextStake: d.liveStake,
    balance: d.liveStake,
    sinceEpoch: d.sinceEpoch ?? null,
    account: { utxo: d.liveStake - withdrawable, rewardsAvailable: withdrawable, totalBalance: d.liveStake },
    withdrawable,
    rewardsSum,
    withdrawalsSum: Math.max(0, rewardsSum - withdrawable),
    runs: [{ pool: 'pool1demo0000000000000000000000000000000000000000000000000', ticker: 'DEMO1', fromEpoch: d.sinceEpoch ?? w.epoch, toEpoch: null }],
    cameFrom: null,
  };
}

function stakeHistory(stake) {
  const w = demoWorld();
  const d = w.delegators.find((x) => x.stake === stake) || w.pending.find((x) => x.stake === stake);
  if (!d) return { epochs: [], events: [], transfers: [], nextEpoch: w.epoch + 1, nextStake: null, granularity: 'epoch', currentEpoch: w.epoch, account: null };
  const from = d.sinceEpoch ?? w.epoch;
  const epochs = [];
  const r = rng('bal', d.liveStakeLovelace % 100000);
  let bal = Math.max(2, Math.round(d.liveStake * (0.55 + r() * 0.2)));
  for (let e = from; e <= w.epoch; e++) {
    bal = Math.round(bal * (1 + 0.00037) + (r() < 0.06 ? d.liveStake * (r() - 0.42) * 0.1 : 0));
    if (e === w.epoch) bal = d.liveStake;
    epochs.push({ epoch: e, runningBalance: Math.max(1, bal) });
  }
  const events = epochs.filter((x, i) => i > 1 && i % 3 === 0).map((x, i) => ({
    epoch: x.epoch, kind: 'reward', amount: Math.round(x.runningBalance * 0.00037 * 3),
    txHash: demoTxHash(stake.slice(-8), i),
  }));
  const transfers = epochs.length > 8 ? [{
    epoch: w.epoch - 5, amount: Math.round(d.liveStake * 0.06),
    txHash: demoTxHash(stake.slice(-8), 99), time: null,
  }] : [];
  const detail = delegatorDetail(stake);
  return {
    epochs, events, transfers,
    nextEpoch: w.epoch + 1, nextStake: d.liveStake,
    granularity: 'epoch', currentEpoch: w.epoch,
    account: detail ? detail.account : null,
  };
}

/** The demo capability source. Answers only while demo mode is active — the
 *  registry's mode gate (capabilities.js) hides it in live and hides every
 *  live source in demo, which is what makes the two worlds unmixable. */
export const demoSource = {
  id: 'demo',
  label: 'demo',
  isCli: false,
  provides: () => [
    'DELEGATOR_LIST', 'POOL_LIVE', 'DELEGATOR_LOYALTY',
    'DELEGATOR_DETAIL', 'DELEGATOR_STAKE_HISTORY',
    'EPOCH_BLOCKS', 'EPOCH_IDEAL', 'EPOCH_STAKE', 'EPOCH_DELEGATORS', 'EPOCH_REWARDS',
    'POOL_PARAMS',
  ],
  reachable: () => true,
  version: () => 'synthetic',
  async get(kind, params) {
    const w = demoWorld();
    switch (kind) {
      case 'DELEGATOR_LIST': return [...w.delegators, ...w.pending];
      case 'POOL_LIVE': return poolLive();
      case 'DELEGATOR_LOYALTY':
        return w.delegators.map((d) => ({
          stake: d.stake, tenure: d.tenure, sinceEpoch: d.sinceEpoch, curStake: d.curStake,
          reductionFactor: d.reductionFactor, defected: d.defected,
          defectToPool: d.defectToPool, defectEpoch: d.defectEpoch, defectToAda: d.defectToAda,
        }));
      case 'DELEGATOR_DETAIL': return delegatorDetail(params && params.stake);
      case 'DELEGATOR_STAKE_HISTORY': return stakeHistory(params && params.stake);
      case 'EPOCH_BLOCKS': case 'EPOCH_IDEAL': case 'EPOCH_STAKE':
      case 'EPOCH_DELEGATORS': case 'EPOCH_REWARDS':
        return w.history;
      case 'POOL_PARAMS':
        return { pledge: w.pledge, fixedCost: FIXED_COST, margin: MARGIN };
      default:
        throw new Error(`demo source cannot provide ${kind}`);
    }
  },
};

// ---- read-model surface (history / samples / notifications / loyalty) ------

export function demoEpochHistory() { return demoWorld().history; }
export function demoHistoryMeta() { return { source: 'demo', schema: null, tested: null, stale: false }; }
export function demoLifetime() { const w = demoWorld(); return { blocks: w.lifetimeBlocks, epochs: w.history.filter((r) => r.adopted > 0).length }; }

/** Node-health chart series: 24h of 5-min points, diurnal + seeded noise. */
export function demoSamples(metric, sinceTs) {
  const now = Math.floor(Date.now() / 1000);
  const from = Math.max(Number(sinceTs) || (now - 86400), now - 86400 * 3);
  const out = [];
  const base = {
    cpu_pct: [11, 7], mem_used_pct: [63, 2.4], swap_used_pct: [0.4, 0.3],
    disk_used_pct: [71.2, 0.15], disk_free_bytes: [412e9, 3e9],
    net_rx_bps: [1_350_000, 900_000], net_tx_bps: [980_000, 600_000],
    load1: [0.9, 0.5], rss_bytes: [11.9e9, 0.35e9], gc_live_bytes: [7.1e9, 0.5e9],
    mempool_bytes: [9_500, 14_000], mempool_txs: [11, 14],
    peers_hot: [20, 2], peers_warm: [14, 3],
  }[metric] || [0, 0];
  for (let t = from - (from % 300); t <= now; t += 300) {
    const r = rng('smp:' + metric, Math.floor(t / 300));
    const diurnal = Math.sin((t % 86400) / 86400 * 2 * Math.PI);
    let v = base[0] + diurnal * base[1] * 0.45 + (r() - 0.5) * base[1];
    if (metric === 'mempool_bytes' || metric === 'mempool_txs') v = Math.max(0, v + (r() < 0.04 ? base[1] * 3 * r() : 0));
    out.push({ t: t * 1000, v: Math.max(0, v) });
  }
  return out;
}

/** Live host gauges (matches host-query's scrape shape). */
export function demoHost() {
  const t = Math.floor(Date.now() / 1000);
  const r = rng('host', Math.floor(t / 5));
  const memTotal = 32 * 1024 * 1024 * 1024;
  const memUsedPct = 63 + (r() - 0.5) * 1.6;
  const load1 = Math.round((0.9 + (r() - 0.5) * 0.4) * 100) / 100;
  return {
    cpuPct: Math.max(2, 11 + (r() - 0.5) * 7),
    cores: 8,
    load: load1, load1,
    memTotal, memAvail: Math.round(memTotal * (1 - memUsedPct / 100)), memUsedPct,
    swapUsed: 412 * 1024 * 1024, swapUsedPct: 0.4,
    diskUsedPct: 71.2, diskFree: 412e9,
    netRxBps: Math.max(0, 1_350_000 + (r() - 0.5) * 1_400_000),
    netTxBps: Math.max(0, 980_000 + (r() - 0.5) * 900_000),
    iface: 'eth0',
    uptimeSec: 37 * 86400 + (t % 86400),
    load5: 0.85, load15: 0.8,
  };
}

/** Node-process metrics for NODE HEALTH. Deliberately WITHOUT mempoolBytes or
 *  blockDelay* fields: now2's mempool-flow and propagation panels key their
 *  own synthetic fallbacks on those being absent. */
export function demoNodeMetrics() {
  const t = Math.floor(Date.now() / 1000);
  const r = rng('nodem', Math.floor(t / 5));
  const w = demoWorld();
  return {
    rssBytes: 11.9e9 + (r() - 0.5) * 0.3e9,
    gcLiveBytes: 7.1e9 + (r() - 0.5) * 0.4e9,
    cannotForge: 0,
    // A handful of late leader checks against millions of attempts is the
    // normal state of a healthy BP, so demo shows that rather than a sterile
    // zero. Leader count stays >= forged. /*forge-honesty-v107*/
    slotsMissed: 3,
    aboutToLead: 37 * 86400,
    nodeIsLeader: Math.round(w.cur.leader * demoClock().progress),
    blocksForged: Math.min(w.cur.adopted, Math.round(w.cur.leader * demoClock().progress)),
    peersHot: 20, peersWarm: 14,
  };
}

/** Synthetic node probe for views that show probe facts in demo. */
export function demoProbe() {
  return {
    role: 'BP', pid: 565905, port: 6000, prometheusPort: 12798,
    nodeStartUnix: Math.floor(Date.now() / 1000) - 37 * 86400,
    topologyPath: null, opCertPath: null, args: '',
  };
}

/** Notification feed: recent joins / stake moves / a leave, newest first. */
export function demoNotifications(limit = 200) {
  const w = demoWorld();
  const now = Math.floor(Date.now() / 1000);
  const dayAnchor = now - (now % 3600);       // stable within the hour
  const mk = (i, hoursAgo, type, stake, detail) => ({
    id: 9000 - i, type, stake,
    capturedAt: dayAnchor - Math.round(hoursAgo * 3600),
    detail,
  });
  const d = w.delegators;
  const L = 1_000_000;   // detail amounts are LOVELACE (the view divides)
  const ev = [
    mk(0, 2, 'join', w.pending[0].stake, { amount: w.pending[0].liveStake * L, txHash: demoTxHash('nf', 0) }),
    mk(1, 5, 'stake_up', d[6].stake, { amount: d[6].liveStake * L, delta: 2_400 * L, rewardNetted: 0, txHash: demoTxHash('nf', 1) }),
    mk(2, 9, 'join', w.pending[1].stake, { amount: w.pending[1].liveStake * L, txHash: demoTxHash('nf', 2) }),
    mk(3, 14, 'stake_down', d[9].stake, { amount: d[9].liveStake * L, delta: -5_100 * L, rewardNetted: 0, txHash: demoTxHash('nf', 3) }),
    mk(4, 21, 'join_redelegated', d[14].stake, { amount: d[14].liveStake * L, fromTicker: 'OTHR', fromPool: 'pool1demoothrpoolxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', txHash: demoTxHash('nf', 4) }),
    mk(5, 30, 'stake_up', d[3].stake, { amount: d[3].liveStake * L, delta: 12_800 * L, rewardNetted: 0, txHash: demoTxHash('nf', 5) }),
    mk(6, 41, 'leave_redelegated', demoStakeAddr(880), { amount: 18_400 * L, toTicker: 'ELSE1', toPool: 'pool1demoelsepoolxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', txHash: demoTxHash('nf', 6) }),
    mk(7, 52, 'stake_up', d[21].stake, { amount: d[21].liveStake * L, delta: 940 * L, rewardNetted: 0, txHash: demoTxHash('nf', 7) }),
    mk(8, 66, 'join', d[30].stake, { amount: d[30].liveStake * L, txHash: demoTxHash('nf', 8) }),
    mk(9, 79, 'leave_to_wallet', demoStakeAddr(881), { amount: 2_150 * L, txHash: demoTxHash('nf', 9) }),
    mk(10, 92, 'stake_down', d[17].stake, { amount: d[17].liveStake * L, delta: -1_800 * L, rewardNetted: 0, txHash: demoTxHash('nf', 10) }),
    mk(11, 110, 'join_returning', d[26].stake, { amount: d[26].liveStake * L, fromTicker: 'OTHR', txHash: demoTxHash('nf', 11) }),
  ];
  return ev.slice(0, limit);
}

// ---- peers + geo (RFC 5737 documentation ranges — cannot be real) ----------

const DEMO_PEERS = [
  { ip: '192.0.2.11',    rtt: 8,   city: 'Frankfurt', country: 'Germany',        cc: 'DE', lat: 50.11, lng: 8.68 },
  { ip: '192.0.2.54',    rtt: 12,  city: 'Helsinki',  country: 'Finland',        cc: 'FI', lat: 60.17, lng: 24.94 },
  { ip: '198.51.100.23', rtt: 16,  city: 'Amsterdam', country: 'Netherlands',    cc: 'NL', lat: 52.37, lng: 4.90 },
  { ip: '198.51.100.71', rtt: 22,  city: 'London',    country: 'United Kingdom', cc: 'GB', lat: 51.51, lng: -0.13 },
  { ip: '203.0.113.8',   rtt: 31,  city: 'Warsaw',    country: 'Poland',         cc: 'PL', lat: 52.23, lng: 21.01 },
  { ip: '192.0.2.102',   rtt: 44,  city: 'Ashburn',   country: 'United States',  cc: 'US', lat: 39.04, lng: -77.49 },
  { ip: '198.51.100.140', rtt: 58, city: 'Toronto',   country: 'Canada',         cc: 'CA', lat: 43.65, lng: -79.38 },
  { ip: '203.0.113.77',  rtt: 77,  city: 'Sao Paulo', country: 'Brazil',         cc: 'BR', lat: -23.55, lng: -46.63 },
  { ip: '192.0.2.201',   rtt: 95,  city: 'Singapore', country: 'Singapore',      cc: 'SG', lat: 1.35, lng: 103.82 },
  { ip: '198.51.100.199', rtt: 120, city: 'Tokyo',    country: 'Japan',          cc: 'JP', lat: 35.68, lng: 139.69 },
  { ip: '203.0.113.150', rtt: 140, city: 'Sydney',    country: 'Australia',      cc: 'AU', lat: -33.87, lng: 151.21 },
  { ip: '192.0.2.233',   rtt: 165, city: 'Cape Town', country: 'South Africa',   cc: 'ZA', lat: -33.92, lng: 18.42 },
];

export function demoPeers() {
  return {
    total: DEMO_PEERS.length,
    peers: DEMO_PEERS.map((p, i) => ({ ip: p.ip, port: 3001 + (i % 3), rtt: p.rtt })),
    metrics: { outgoingConns: 8, incomingConns: 4, duplexConns: 3, prunableConns: 2 },
  };
}

/** Geo record in the ip-api-normalised shape the geo cache serves. */
export function demoGeo(ip) {
  const p = DEMO_PEERS.find((x) => x.ip === ip);
  if (!p) return null;
  return { lat: p.lat, lng: p.lng, country: p.country, countryCode: p.cc, city: p.city, as: 'AS64500 DemoNet Transit' };
}
export function demoOwnGeo() {
  return { lat: 47.37, lng: 8.54, country: 'Switzerland', countryCode: 'CH', city: 'Zurich', as: 'AS64496 DemoHost AG' };
}

// ---- relays ----------------------------------------------------------------

/** Synthetic relay snapshot in relay-probe's exact shape. Two relays with
 *  their own peer sets and slightly different load; the tip tracks the same
 *  synthetic chain the Dashboard shows, so the two tabs agree. */
export function demoRelaySnapshot(id) {
  const clock = demoClock();
  const t = Math.floor(Date.now() / 1000);
  const r = rng('relay:' + id, Math.floor(t / 5));
  const second = id === 'relay2';
  const peerSlice = second ? DEMO_PEERS.slice(4).concat(DEMO_PEERS.slice(0, 2)) : DEMO_PEERS.slice(0, 9);
  return {
    probe: {
      ok: true, reason: null, detail: null,
      version: '10.5.1', role: 'RELAY',
      config: second ? 'cnode_relay2' : 'cnode_relay',
      nodeCount: 1, pid: second ? 5150 : 4242,
    },
    health: {
      ok: true,
      blockNum: clock.tipBlock,
      // relay.js dates the tip via real-mainnet slot->unix (anchor 1596059091);
      // the demo clock's anchor sits exactly one epoch later, so shift the
      // absolute slot or the tab reads "STALLED · 432000s ago".
      slotNum: clock.absSlot + 432000,
      slotInEpoch: clock.slotInEpoch,
      density: 0.0501,
      outbound: second ? 10 : 12,
      inbound: second ? 24 : 31,
      duplex: 3,
      peersHot: second ? 18 : 20,
      peersWarm: 14, peersCold: second ? 96 : 112,
      mempoolBytes: Math.max(0, Math.round(9_000 + (r() - 0.4) * 22_000)),
      mempoolTxs: Math.max(0, Math.round(10 + (r() - 0.4) * 22)),
      blockDelayLast: 0.28 + r() * 0.5,
      blockDelayCdf1: 0.992, blockDelayCdf3: 1, blockDelayCdf5: 1,
    },
    peers: peerSlice.map((p, i) => ({ ip: p.ip, port: 3001 + (i % 2), localPort: 6000 + i, rtt: p.rtt + (second ? 4 : 0) })),
  };
}

// ---- dashboard production figures (demo.js delegates here) -----------------

export function demoBlockProduction() {
  const w = demoWorld();
  const c = w.cur;
  const progress = demoClock().progress;
  const adoptedSoFar = Math.min(c.adopted, Math.round(c.leader * progress));
  return {
    leader: c.leader,
    ideal: c.ideal,
    luckPercent: c.ideal > 0 ? Math.round((c.leader / c.ideal) * 100) : 0,
    adopted: adoptedSoFar,
    confirmed: adoptedSoFar,
    lost: progress > 0.6 ? c.lost : 0,
    leaderKnown: true,
  };
}

export function demoAdaPrice() {
  const day = Math.floor(Date.now() / 86400000);
  const r = rng('ada', day);
  return { usd: 0.78 + r() * 0.12, chg24h: (r() - 0.45) * 4 };
}
