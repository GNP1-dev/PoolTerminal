# Hard fork awareness — PoolTerminal

This document tracks all areas of PoolTerminal that may need attention when a Cardano hard fork is upcoming or has just occurred. It's a running list, updated as the codebase grows.

If you're forking PoolTerminal or auditing it ahead of a hard fork, this is the file to read.

---

## Currently active fork target

**Van Rossem** (upcoming, date TBC by IOG)

Status: PoolTerminal not yet released. Will support Van Rossem from v1.0.

Known impacts:
- Cost model adjustments expected — Plutus serialisation unchanged
- Node version target: 10.7.x (current mainnet: 10.5.4)
- Watch [IOG SPO Announcements Telegram](https://t.me/CardanoStakePoolWorkgroup) for go signal

## Past forks supported

_None yet — PoolTerminal is pre-release._

## Code areas marked for fork attention

Search the codebase for `// HARDFORK:` comments to find every line that may need attention at a fork. Categories listed here are the ones we know about ahead of time.

### Protocol parameter queries

The output schema of `cardano-cli latest query protocol-parameters` can gain fields at hard forks. PoolTerminal parses this output to display protocol params; new fields will display as "unknown" until the parser is updated.

### Cost models

New Plutus cost model versions are introduced at hard forks. The cost-model viewer in PoolTerminal shows current vs previous era — needs updating to include each new era as it arrives.

### cardano-cli command syntax

Where possible, PoolTerminal uses `cardano-cli latest <command>` which auto-selects the current era. Some specific queries that don't have a `latest` alias are pinned to the current era — those need updating per fork.

Pinned queries (audit on fork):
- _(none currently — to be populated as code is written)_

### Tip query JSON structure

`cardano-cli latest query tip` has gained fields in previous forks (e.g. `epoch`, `slotInEpoch`, `syncProgress`). PoolTerminal's tip parser should fail gracefully if fields are missing and ignore unknown fields.

### Stake distribution & pool params

`getStakeDistribution` and pool-params query formats can change. The HISTORY view's long-term stake-movement chart depends on consistent schemas; era boundaries may produce visible discontinuities.

### Governance queries

Governance queries were entirely new in Conway era. They will continue to evolve. PoolTerminal's GOVERNANCE view must be re-validated at every Conway-line fork.

Active governance query usage:
- _(none currently — to be populated as code is written)_

### DRep registration / voting

DRep schema and voting rules are actively evolving. The DRep section of the GOVERNANCE view needs careful audit at every fork during the Conway era.

### Treasury withdrawal mechanics

Treasury withdrawal proposals and their voting mechanics are still being refined. The treasury-proposal view must be re-validated per fork.

### Reward calculation

Cardano reward formulae have been tweaked multiple times. The HISTORY view's "you vs network" comparison and the REWARDS view's per-epoch waterfall depend on accurate calculation; era boundaries should be visually flagged.

### KES rotation rules

KES period length and rotation rules are unlikely to change soon but theoretically can. The KES tank and rotation countdown should validate against current protocol params at runtime, not against hardcoded constants.

### Mempool transaction format

New transaction types add fields. PoolTerminal's mempool live feed parses tx metadata; new tx types should display as "(unknown type)" rather than crashing the feed.

## Pre-fork checklist

PoolTerminal includes an in-app checklist that activates 30 days before a known upcoming fork. Items:

- [ ] Node version current (>= announced minimum for the fork)
- [ ] cncli version current
- [ ] KES not expiring during the fork window
- [ ] Pool key backups verified
- [ ] DRep voting up to date (if applicable)
- [ ] Pool retirement / re-registration not pending during window
- [ ] Test in preview/preprod environment if pool has a sister node

## How to update this document after a fork

1. Move the previous "Currently active fork target" to "Past forks supported" with the date of the fork
2. Set new "Currently active fork target" (the next known fork)
3. List known impacts for that fork
4. Audit each "Code areas marked for fork attention" section against the released code
5. Update pinned-query lists with current usage
6. Tag a new PoolTerminal release confirming compatibility with the new era

---

_Last updated: 27 May 2026_
