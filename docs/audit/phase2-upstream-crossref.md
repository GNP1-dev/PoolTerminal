# Phase 2 - upstream changes cross-referenced to the Phase 1 inventory

Source notes, with URLs, quotes and VERIFIED/UNVERIFIED tags: gathered by diffing
the cardano-node, cardano-cli, ouroboros-network, hermod-tracing, cncli,
guild-operators and cardano-db-sync sources at the relevant tags (2026-09-24).
Provisional ratings: Phase 4 confirms or overturns each against the real BP
capture.

## Versions confirmed

| component | BP host (reported) | db-sync host (measured) | upstream notes |
|---|---|---|---|
| cardano-node | 11.1.2 (fef83fed) | 11.0.1 (97036a66) | 11.1.0 pre-release 21 Aug; 11.1.1 8 Sep; 11.1.2 17 Sep ("PV minor in header", time-lock memory fix) |
| cardano-cli | 11.2.3.0 | 11.0.0.0 | 11.2.3.1 exists (tx-building fix only) |
| cncli | 6.8.0 | 6.7.0 | 6.8.0: sign/verify `--message` -> `--domain`/`--nonce`; VRF lib swap; no DB/output change |
| db-sync | - | 13.7.2.1, schema **15.50.6** | no release supports node 11.1.x; `epoch` is now a VIEW (measured) |
| Ogmios | - | v7.0.0 | nothing since 20 June; tested against 11.0.1 only |
| Guild env | captured in Phase 3 | old gate (node >= 11.0.1, cli >= 11.0.0.0) | alpha `bbaa6b0d` (23 Sep) gate node >= 11.1.2, cli >= 11.2.3 (3-part compare) |

## Cross-reference

| upstream change | PoolTerminal touchpoint (phase1-inventory.md) | provisional impact |
|---|---|---|
| Legacy tracing (iohk-monitoring) and EKG removed; `hasEKG`/`hasPrometheus` ignored; `TurnOnLogging`/`TurnOnLogMetrics`/`UseTraceDispatcher` parsed but inert | Section C: app uses only the PrometheusSimple endpoint, never EKG | **OK**, no EKG use. Prometheus port is auto-detected as the *first* non-node-port listener (node-probe.js:173, relay-probe.js:100). On the db-sync host that happens to be its metrics port because of `ss` ordering; any second listener (e.g. an rpc socket) could be picked instead -> **AT RISK**, check the BP capture's listener list |
| Metric names: every 11.0.1 metric used by the app still exists with the same suffix in 11.1.2; only txSubmission `numOf*` removed (+17 new), Peras + rpc metrics added | Section C: all 25 names | **OK expected**. Baseline shows all non-forge names present on 11.0.1; the forge set (`blocksForged`, `nodeIsLeader`, `nodeCannotForge`, `slotsMissed`, `Forge_about_to_lead_counter`) only exists on a BP - verify in the BP capture |
| `TraceOptionMetricsPrefix` without a trailing dot now gets one added | every name is hard-coded as `cardano_node_metrics_...` | **AT RISK** for operators with a custom prefix (names never match -> panels silently empty). Guild and upstream configs are unaffected. Verify BP/relay prefix in the capture |
| `connectionManager.prunableConns` never emitted | app reads `fullDuplexConns_int` for "Duplex" | OK; the comment at metrics-query.js:14 is stale |
| cardano-cli 11.0 -> 11.2.3: no flag, default or JSON-shape changes for tip, stake-snapshot, kes-period-info, leadership-schedule, tx-mempool; legacy `query` group kept, no deprecation text | Section B | **OK expected**; confirm tip/mempool/stake-snapshot JSON in the capture. leadership-schedule cannot be captured (VRF skey); the help-text flag check stands in for it |
| cli 11.2.2.0+: every query first checks the network id against the node genesis | Section B (1 s tip loop) | **AT RISK (perf)**: an extra round trip on every 1 s tip query. Compare the tip latency in the app console (`[live]` timings) before and after |
| cardano-cli#1434: cli 11.1.0.0-11.2.2.0 against node 11.0.x hangs forever on `query tip` / `kes-period-info` | Section B; `ssh_run` has **no timeout** (ssh.rs:441-483, no timeout in ssh.rs/localrun.rs) | BP pair (11.1.2 + 11.2.3.0) is safe. **AT RISK** for users with a mismatched pair and for the db-sync host if the cli is upgraded before the node: the fast loop would wait forever with no error |
| Guild alpha env `bbaa6b0d`: version gate runs `return 1` at env:1078, *after* `CCLI` is set but *before* socket, `NETWORK_IDENTIFIER`, `POOL_ID` and genesis vars | Section A: probe sends env output to `/dev/null`, requires only `__PROBE_OK__` + `CCLI`, then defaults socket/network | **AT RISK / silent**: on an 11.0.x node with updated Guild scripts the app "connects" with empty POOL_ID (no Ideal, leadership-schedule gets an empty `--stake-pool-id`) and never shows Guild's upgrade message. Affects public users, and the db-sync host if its scripts are updated before its node |
| Ledger snapshot interval now in slots on a fixed grid (Guild `SnapshotInterval: 43200` ~ 12 h) | propagation history / NODE HEALTH GC sawtooth | informational: the 12 h GC/snapshot sawtooth phase now follows chain slots, not node start time |
| Log namespace changes (`IgnoreBlockOlderThanK` -> `IgnoreBlockOlderThanImmTip`, V1/LMDB messages gone, new Snapshot* debug events); startup strings unchanged | Section E: Logs presets | Presets don't grep any renamed string. **But** the baseline shows the presets are already mismatched with new-tracing JSON logs on 11.0.1: "Errors & warnings" (`\((Warning\|...`) matched 0 lines, "Restarts & startup" matched only `SwitchedToAFork` lines. Verify against the BP's log format |
| CNCLI 6.8.0: no sync/leaderlog/validate/status output or schema change | Section D (chain table, blocklog table), Section E leader/validate presets | **OK expected**; confirm `.schema` in the capture |
| db-sync 13.7.2.1: `epoch` -> VIEW (`epoch_finalized` + `epoch_current`), ~500 ms slower | Section F: dbsync-query.js:145, 812, 818, 1085 | **DEGRADED (perf)**, results unchanged. :1085 joins `epoch` only to read `e.no`, which already equals `b.epoch_no`, so the join can go. :812/:818 run `MAX(no) FROM epoch` twice per account |
| schema 15.50.6 vs `DBSYNC_TESTED_SCHEMA = '15.44.6'` | dbsync-query.js:24, 1159 | app already flags "tested 15.44.6 - verify" (pre-existing, unrelated to node 11.1.2) |
| no Ogmios / submit-api / gLiveView / cntools use | Section H | OK; Ogmios only matters for the watch list |

## Found while building the baseline (not upstream changes)

- src/main.js:358: `pgrep -f 'cardano-node run'` does not match `cardano-node +RTS -N6 -RTS run ...` (the db-sync host's command line), so candidate 1 fails (`/proc/exe: No such file`) and candidate 2 (the probed PID) saves it. On a host with two nodes (the BP host, running a BP and a relay) `head -1` may pick the other node's binary; harmless while both are 11.1.2.
- The db-sync host's cnode has no `--port` argument (listens on the default 6000), so the "exclude the node port" filter in node-probe.js:173 excludes nothing; `ss` ordering alone decides the Prometheus port.
