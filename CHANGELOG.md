# Changelog

All notable changes to PoolTerminal are recorded here.

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version stays below 1.0 the application is beta: interfaces and
behaviour may change between minor versions.

## [0.3.4] - 2026-09-09

### Fixed

- **PoolTerminal no longer pins a CPU core while it is open.** The
  Dashboard's heartbeat trace, the upcoming blocks strip and the Relay
  tabs' ECG each ran a requestAnimationFrame loop that rewrote the page
  sixty times a second whether or not anything had changed, and the glow
  on every moving heartbeat complex was a Gaussian blur re-rasterised on
  every one of those frames. Under WebKitGTK that is a full software
  repaint per frame, and the web process sat at 100-135% CPU for as long
  as the app was open: fan noise and battery drain on a laptop, and on a
  machine shared with a node, CPU the node does not get. All motion now
  runs from one shared 1 Hz ticker (everything it animates is
  second-resolution), a write is skipped when the value has not changed,
  the glow is applied once to the static trace container instead of to
  each moving path, and the ticker and every CSS animation stop entirely
  while the window is hidden. Two smaller always-on animations went the
  same way: the KES hourglass's falling sand, which was a 60 fps SVG
  animation that could not be paused, now steps at 8 Hz from the same
  ticker, and the mempool sparkline's current-value marker, which pulsed
  continuously with a re-rendered glow, is now a static glow that moves
  with each 5-second redraw.

  A connected, live Dashboard had a second layer of the same problem: the
  tip-diff needle is re-set every second and its 1.2-second smooth CSS
  transition never finished, so it repainted every frame for as long as
  the node was live, and the Bloomberg flash, the mempool tanks, the
  hero bars, the epoch thermometer and the metadata-feed slide-in each
  added their own per-frame repaints whenever a value changed. Every
  transition and animation on a live-updating element now uses a stepped
  timing function, so a needle sweep costs eight paints instead of about
  seventy and a flash eight instead of about a hundred. The motion reads
  the same; the per-frame repaint is gone. The loading spinners were the
  last per-frame animation: infinite 60 fps rings shown until each panel's
  first data, which on a live node can be two minutes for the leadership
  schedule. They now step at 10 frames a second, so the first minutes
  after connecting no longer run at 15-20%.

  Measured on the release build on the same machine. Dashboard in demo
  mode behind the connect modal: WebKit web process from an average of
  135% CPU to 4%, and 0.2% with the window minimised. A controlled
  1440x1000 WebKitGTK page with one needle re-set each second plus one
  flash: 16% with the old smooth transition, 2.4% stepped, 0.3% with no
  transition. A live-connected Dashboard on 0.3.3 averaged 25-30% of a
  core over its whole run.
- **The Node Health Forge card flagged CHECK on healthy pools.** It
  treated the node's `slotsMissed` counter as missed blocks and escalated
  on any non-zero value. That counter is late leadership checks: slots
  the forge loop did not evaluate in time because of CPU, IO or a GC
  pause, which every block producer accrues and on which the node was
  almost never leader. It had flagged a pool that had not been scheduled
  at all. The card now escalates only on `nodeCannotForge`, the counter
  that means the node was scheduled and could not mint.

### Changed

- **Forge figures on Node Health carry their denominator.** The card now
  reads "leader N · forged M", so a forged count of zero is seen against
  how often the node was actually scheduled. The Live detail grid gains
  Leader slots, Cannot-forge errors and Late leader checks, the last shown
  as "n of total (%)" against the number of leadership checks the node set
  out to run. Demo mode shows the same shape rather than a sterile zero.

## [0.3.3] - 2026-08-28

### Added

- **Demo mode now populates every view.** Previously only the Dashboard had
  synthetic data and the other tabs rendered empty, which meant anyone
  evaluating PoolTerminal before connecting it to a block producer saw
  half an application. Delegators, History, Notifications, Node health,
  Logs, Data, Map and both Relay tabs are now filled from a single
  deterministic synthetic world: a 211-epoch pool with 107 delegators,
  two pending joiners, realistic luck, lost blocks and blockless epochs.
  Figures are internally consistent across tabs and stable within an
  epoch, so what you see on one screen agrees with every other.
- Stake addresses and transaction hashes in demo mode are correctly
  formed but resolve to nothing on chain, so no demo delegator can be
  looked up and found to be a real person.
- A leak-audit harness (`src/dev/leak-tour.js`), inert unless armed, which
  fills every live-side surface, switches to demo, walks all twelve tabs
  and scans each for real values. It runs against a packaged build, so a
  release can be audited as the artefact users will actually download.
- `RELEASING.md`, a release checklist gated on that audit.

### Fixed

- **Real pool data could appear in demo mode.** Three view-level caches
  held live data and repainted it after a switch to demo: the delegator
  list (every delegator address, stake and loyalty row, plus the pool's
  hero figures), the dashboard's last snapshot including upcoming leader
  slot times, and the on-chain metadata feed. All three are now dropped
  when the mode changes, and the delegator cache additionally records
  which mode filled it. An operator could previously have screenshotted a
  screen labelled DEMO that was showing their own delegators.
- **Demo mode made external network calls.** It geolocated the user's own
  IP address, and every map fetched its basemap from a CDN. Geolocation
  is now synthetic in demo, and the basemap is bundled, which also means
  maps work offline in live mode.
- **The Logs workspace showed real values in demo.** Its sample output had
  been captured from a real node during development and lightly relabelled,
  so demo mode displayed genuine leader-slot counts, block heights,
  process IDs and KES periods. All samples are now generated from the
  synthetic world. The About view no longer names the connected host in
  demo, and the Alerts view no longer renders a real bot token or chat ID.
- **Background collectors kept running after switching to demo.** Long
  history and enrichment loops carried on until they were rejected by the
  isolation guard, filling the console with errors and consuming retry
  attempts. They now stop cleanly on a mode change and resume on return
  to live.
- **Reconnecting to a node required the whole setup wizard again.**
  Disconnecting now returns to the connect screen prefilled from saved
  configuration, so reconnecting is a single action. The wizard remains
  one click away for genuinely changing node or settings, and a failed
  connection explains itself rather than dropping into setup.
- **Disconnecting deleted the local cache.** Any visit to demo mode by way
  of Disconnect cost the operator their entire notification history. The
  cache is now cleared at connect time and only when connecting to a
  different pool, which preserves the protection it was there for at none
  of the cost.
- **Telegram alert configuration was stored in that cache**, so
  disconnecting silently deleted the bot settings, which then appeared to
  vanish at the next launch. Alert configuration now lives with the other
  user settings, where no cache-clearing routine can reach it. Existing
  settings are migrated automatically.
- **Logs defaults are derived from the connected node.** They were
  previously hardcoded, which meant they suited one particular layout and
  every other operator had to correct them by hand. The unit name and
  blocklog path are now read from the node's own environment.

### Removed

- Personal values that had been hardcoded as defaults and examples: a
  block producer's LAN address and username in the connect form, a real
  delegator's stake address in a developer test, a specific pool ticker as
  a fallback, and several non-standard paths presented as defaults.

## [0.3.2] - 2026-08-27

### Added

- **Delegators joining the pool now appear before their stake goes
  active.** Previously a new delegator was invisible until the epoch
  boundary. Pending rows are dulled, tagged with the epoch their stake
  activates, and excluded from pool totals and the delegator count. The
  count card shows "+N joining" as a link that jumps to them.
- Pending rows show a dashed gold outline on the loyalty bar, sized to
  their stake weight. It marks the ceiling the bar will grow toward
  rather than a score, since tenure only starts accruing once the stake
  is active.
- The setup wizard can be closed when it is opened from Settings on a
  working install, with a close button and Escape. Cancelling discards
  everything and leaves the existing configuration untouched. First-run
  and the Change Node flow deliberately have no close control, since
  cancelling there would leave the app unusable.

### Fixed

- **The version shown in the app was hardcoded and wrong.** The header,
  About view and setup wizard each carried their own string; the wizard's
  had said 0.1.0 since three releases ago. All three now read the version
  from the packaged binary, so they cannot drift again.
- **A pending delegator's stake was shown far too high** — one 200,102
  ADA joiner displayed as 12,010,647 ADA. The query summed transaction
  outputs filtered only on `consumed_by_tx_id`, which is sparsely
  populated in db-sync, so long-spent outputs were counted as unspent.
  The figure was closer to lifetime ADA received than current balance.
  It now uses a proper UTxO anti-join. Active rows were never affected,
  as they come from the ledger's own snapshot.
- Stake in the delegator list is shown in whole ADA. Small balances were
  previously printed as raw floats and large ones abbreviated.
- Sorting the delegator list now repositions pending rows. They sort
  inline by stake, and group at the end when sorting by loyalty, since a
  pending delegator has no loyalty score to compare.

### Removed

- Two dead functions in the delegators view with no callers.

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

[0.3.4]: https://github.com/GNP1-dev/PoolTerminal/releases/tag/v0.3.4
[0.3.3]: https://github.com/GNP1-dev/PoolTerminal/releases/tag/v0.3.3
[0.3.2]: https://github.com/GNP1-dev/PoolTerminal/releases/tag/v0.3.2
[0.3.1]: https://github.com/GNP1-dev/PoolTerminal/releases/tag/v0.3.1
[0.3.0]: https://github.com/GNP1-dev/PoolTerminal/releases/tag/v0.3.0
[0.2.0]: https://github.com/GNP1-dev/PoolTerminal/releases/tag/v0.2.0
[0.1.0]: https://github.com/GNP1-dev/PoolTerminal/releases/tag/v0.1.0
