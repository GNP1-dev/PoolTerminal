/**
 * PoolTerminal — capability spine.
 *
 * The source-agnostic core of the data layer (architecture note §3, §6, §7).
 * Views and the read-model speak only in DataKinds and ask this registry
 * "can anyone answer this?" — they never name a source. Sources register what
 * they `provide()`; the resolver picks which source answers a given DataKind by
 * explicit rule (authority + preference), never by accident.
 *
 * Nothing here knows about SSH, Postgres, Koios, or GNP1. It's pure routing.
 */

// ---- DataKinds: the fixed semantic vocabulary ------------------------------
// Adding one is a deliberate, rare act. Views/read-model reference only these.
export const DataKind = Object.freeze({
  // Live (node)
  TIP: 'TIP',
  SYNC: 'SYNC',
  KES: 'KES',
  IDEAL_CURRENT: 'IDEAL_CURRENT',
  LEADER_SCHEDULE: 'LEADER_SCHEDULE',
  PEERS: 'PEERS',
  MEMPOOL: 'MEMPOOL',
  FORGE_HEALTH: 'FORGE_HEALTH',
  CHAIN_PULSE: 'CHAIN_PULSE',
  // Node health
  HOST_RESOURCES: 'HOST_RESOURCES',
  NODE_PROCESS_METRICS: 'NODE_PROCESS_METRICS',
  // Historical (per-epoch)
  EPOCH_BLOCKS: 'EPOCH_BLOCKS',
  EPOCH_IDEAL: 'EPOCH_IDEAL',
  EPOCH_STAKE: 'EPOCH_STAKE',
  EPOCH_DELEGATORS: 'EPOCH_DELEGATORS',
  EPOCH_REWARDS: 'EPOCH_REWARDS',
  // Identity / params
  POOL_PARAMS: 'POOL_PARAMS',
  REWARD_ADDRESS: 'REWARD_ADDRESS',
});

export const ALL_DATAKINDS = Object.freeze(Object.values(DataKind));

// ---- Resolution rules (architecture note §6) -------------------------------
// Current-epoch values are ALWAYS the cli's when a cli source is present — this
// is the rule that kept the leader count correct when cncli held phantom slots.
const CLI_AUTHORITATIVE = new Set([DataKind.IDEAL_CURRENT, DataKind.LEADER_SCHEDULE]);

// Historical preference: local-and-free beats public-limited beats keyed.
// Lower index = preferred. Sources not listed fall to the end (registration order).
const HISTORY_PREFERENCE = ['node-cli', 'dbsync', 'koios', 'blockfrost'];

// DataKinds whose preferred answer follows HISTORY_PREFERENCE.
const HISTORY_KINDS = new Set([
  DataKind.EPOCH_BLOCKS, DataKind.EPOCH_IDEAL, DataKind.EPOCH_STAKE,
  DataKind.EPOCH_DELEGATORS, DataKind.EPOCH_REWARDS,
  DataKind.POOL_PARAMS, DataKind.REWARD_ADDRESS,
]);

/**
 * A Source is any object with this shape (duck-typed, not enforced):
 *   id          string         stable id, e.g. 'node-cli' | 'dbsync' | 'koios'
 *   label        string        display name, e.g. 'db-sync'
 *   isCli        boolean        true for the cardano-cli source (authority)
 *   provides()   () => DataKind[]            what it can answer right now
 *   reachable()  () => boolean              can it connect right now
 *   version()    () => string | null        for UI ('Data: db-sync v13.x')
 *   get(kind, params) => Promise<any>        answer in the canonical row shape
 * The registry uses only these; it never inspects a source's internals.
 */

// ---- Registry --------------------------------------------------------------

class CapabilityRegistry {
  constructor() { this._sources = []; }

  /** Replace all sources (called on connect / config change). */
  setSources(sources) { this._sources = Array.isArray(sources) ? sources.slice() : []; }

  register(source) { if (source) this._sources.push(source); }
  clear() { this._sources = []; }
  all() { return this._sources.slice(); }

  /** Sources that currently provide `kind` and are reachable. */
  _candidates(kind) {
    return this._sources.filter((s) => {
      try { return s.reachable() && s.provides().includes(kind); }
      catch { return false; }
    });
  }

  /** Can any configured, reachable source answer this DataKind? */
  can(kind) { return this._candidates(kind).length > 0; }

  /**
   * The single source chosen to answer `kind`, by rule:
   *   1. CLI-authoritative kinds → the cli source if present.
   *   2. History kinds → HISTORY_PREFERENCE order.
   *   3. Otherwise → registration order.
   * Returns the source object, or null if none can answer.
   */
  resolve(kind) {
    const cands = this._candidates(kind);
    if (!cands.length) return null;

    if (CLI_AUTHORITATIVE.has(kind)) {
      const cli = cands.find((s) => s.isCli);
      if (cli) return cli;
    }
    if (HISTORY_KINDS.has(kind)) {
      const ranked = [...cands].sort((a, b) => prefRank(a.id) - prefRank(b.id));
      return ranked[0];
    }
    return cands[0];   // registration order
  }

  /** Convenience: resolve and call get(). Throws a clear error if nothing answers. */
  async get(kind, params) {
    const src = this.resolve(kind);
    if (!src) throw new Error(`No source can provide ${kind}`);
    return src.get(kind, params);
  }

  /** {name, version} of the source currently answering `kind` — for UI headers. */
  describe(kind) {
    const src = this.resolve(kind);
    if (!src) return null;
    return { id: src.id, name: src.label, version: safeCall(() => src.version()) };
  }

  /** Full map DataKind -> active source id|null — powers the settings page. */
  snapshot() {
    const out = {};
    for (const k of ALL_DATAKINDS) { const s = this.resolve(k); out[k] = s ? s.id : null; }
    return out;
  }
}

function prefRank(id) {
  const i = HISTORY_PREFERENCE.indexOf(id);
  return i === -1 ? HISTORY_PREFERENCE.length : i;
}
function safeCall(fn) { try { return fn(); } catch { return null; } }

// One shared registry for the app.
export const registry = new CapabilityRegistry();
