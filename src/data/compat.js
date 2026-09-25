/**
 * PoolTerminal — declared minimum versions of the node-side tools.
 *
 * The ONE place in code the supported minimums live; the About page reads them
 * from here. README.md ("Requirements") and HARDFORK.md state the same values in
 * prose - RELEASING.md step 3 keeps them in sync on every release.
 *
 * Basis: the cardano-node 11.1.2 compatibility audit and its follow-up fixes
 * (docs/audit/node-11.1.2-compat-2026-09-24.md), checked against a block
 * producer and relay on node 11.1.2 / cli 11.2.3.0 / cncli 6.8.0.
 *
 * cardano-cli and cardano-node must be a matched pair from the same node
 * release: cli 11.1.0.0-11.2.2.0 against node 11.0.x hangs on `query tip`.
 * The db-sync schema PoolTerminal was last verified against is
 * DBSYNC_TESTED_SCHEMA in dbsync-query.js (it drives the "verify" warning).
 */

export const MIN_CARDANO_NODE = '11.1.2';
export const MIN_CARDANO_CLI  = '11.2.3.0';
export const MIN_CNCLI        = '6.8.0';
