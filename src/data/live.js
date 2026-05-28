/**
 * PoolTerminal — live data source.
 *
 * Talks to the real block producer via the Tauri SSH commands (ssh_run), Koios,
 * and the local SQLite cache. Phase 0: interface STUB only — each method throws
 * a clear "not implemented" so the contract is complete and the router works.
 *
 * Phase 1 fills these in. Implementation notes captured now so the work is
 * unambiguous later:
 *
 *   getNowSnapshot:
 *     - epoch/slot/tip: `cardano-cli query tip` (ABSOLUTE PATH or source Guild
 *       env first — cardano-cli is NOT on PATH in a non-interactive SSH shell)
 *     - KES: from op cert / `cncli` or node metrics (Prometheus :12798)
 *     - peers: `ss` / Prometheus
 *     - forging: Prometheus Forge_node_is_leader / blocksForged counters
 *     - blockProduction: cncli SQLite (/opt/cardano/cnode/guild-db/cncli/cncli.db)
 *       + Koios for ideal/luck
 *     - poolPulse: computed locally from the above (DESIGN.md §11)
 *
 *   getUpcomingBlocks:
 *     - cncli leaderlog / slots table for assigned slots this epoch
 *
 *   getChainPulse:
 *     - tip diff from `cardano-cli query tip`; recent block times from node /
 *       Koios; density from blocks/slots over each window
 *
 *   getMempool:
 *     - node mempool metrics (Prometheus) or local query
 *
 * All persisted to the cache (cache_put_epoch / cache_put_sample) so HISTORY
 * views accumulate over time.
 */

import './contract.js';

function notYet(what) {
  throw new Error(`live: ${what} not implemented yet (Phase 1)`);
}

export class LiveDataSource {
  constructor() {
    this.mode = 'live';
  }

  async getPoolIdentity() {
    notYet('getPoolIdentity');
  }
  async getNowSnapshot() {
    notYet('getNowSnapshot');
  }
  async getUpcomingBlocks() {
    notYet('getUpcomingBlocks');
  }
  async getChainPulse() {
    notYet('getChainPulse');
  }
  async getMempool() {
    notYet('getMempool');
  }
}
