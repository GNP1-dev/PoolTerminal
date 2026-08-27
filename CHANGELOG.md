# Changelog

All notable changes to PoolTerminal are recorded here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version stays below 1.0 the application is beta: interfaces and
behaviour may change between minor versions.

## [0.3.1] - 2026-08-27

### Fixed

- **Operational certificate counters did not refresh after a KES rotation.**
  The "on disk" and "on chain" counters were read once when the app connected
  to the node and never read again. The KES fields beside them refreshed every
  60 seconds as intended, so the panel appeared live while the OPCERT numbers
  were frozen at their connection-time values. After a rotation an operator
  could see two matching counters and conclude the rotation had gone cleanly
  while in fact looking at pre-rotation state. Only a restart or reconnect
  revealed the true values.

  Both counters now come from the same `kes-period-info` call that already
  refreshes the KES panel. The duplicate one-shot call has been removed.

  **If you rotated KES while running 0.3.0, re-check your operational
  certificate counter with `cardano-cli`.**

- **Stale values could be displayed indefinitely.** The counters are now
  cleared whenever a reading cannot be taken. If the certificate path is
  missing, the SSH call fails, or the response omits the counters, the panel
  shows "querying node…" rather than the last known value.

- **The healthy colour rule rejected legitimate states.** Only `disk == chain`
  and `disk == chain + 1` were treated as healthy, which flagged an error for
  pools that go a long time between blocks and legitimately sit two or more
  ahead after successive rotations. The rule is now `disk >= chain` healthy,
  with red reserved for `disk < chain`, which should not occur in normal
  operation.

### Added

- The operational certificate panel now shows the time its reading was taken.

## [0.3.0] - 2026-08-04

### Added

- A delegator's **Movements** now lists the ADA actually moved in and out per
  transaction, not just rewards and withdrawals, so a balance-change
  notification can be traced to the transaction behind it and to the epoch its
  stake lands in.

### Fixed

- Per-epoch active stake no longer presents the next epoch's snapshot as the
  current one.

## [0.2.0] - 2026-07-30

### Added

- **LOGS** workspace: journal queries, minted-block history, propagation
  history and an epoch-transition view.
- **ALERTS**: Telegram alerting with no agent required on the block producer.
- The **KES hourglass**.
- Delegator balances reconciled against live account state.

## [0.1.0]

- Initial release.

[0.3.1]: https://github.com/GNP1-dev/PoolTerminal/releases/tag/v0.3.1
[0.3.0]: https://github.com/GNP1-dev/PoolTerminal/releases/tag/v0.3.0
[0.2.0]: https://github.com/GNP1-dev/PoolTerminal/releases/tag/v0.2.0
[0.1.0]: https://github.com/GNP1-dev/PoolTerminal/releases/tag/v0.1.0
