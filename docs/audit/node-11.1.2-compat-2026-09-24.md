# PoolTerminal compatibility audit: cardano-node 11.1.2

- **Date:** 24 September 2026
- **Code audited:** PoolTerminal `main` at b176051 (v0.3.4 + 4), identical to `origin/main`
- **Scope:** audit only. No source file has been changed.

Supporting files, all in `docs/audit/`:

| file | contents |
|---|---|
| `phase1-inventory.md` | every external touchpoint, with file:line, the exact command and how the output is parsed |
| `phase2-upstream-crossref.md` | the upstream changes mapped to those touchpoints |
| `capture-bp-11.1.2.sh` | the read-only capture script |
| `capture-bp-11.1.2.txt` | output from the BP host (BP 11.1.2 and co-located relay), run with `--with-kes` (local only, not committed) |
| `capture-206-11.0.1.txt` | baseline from the db-sync host (11.0.1, non-BP) (local only, not committed) |

## 1. Summary

**PoolTerminal is safe to use against 11.1.2 today. Nothing is BROKEN.** The upgrade breaks no interface the app depends on:

- **cardano-cli 11.2.3.0:** `query tip`, `query tx-mempool info`, `query stake-snapshot` and `query kes-period-info` give JSON identical in shape to 11.0.0.0, with no warnings on stdout. I ran the app's own parsing expressions over the captured output and they parsed cleanly: KES periods, op-cert counters and key expiry all read correctly. The Ideal value they produced was wrong, but not because of 11.1.2: the app reads the wrong stake snapshot (D3, found in the manual test).
- **Prometheus:** every metric name the app reads is present on the BP (<bp-metrics-port>) and the relay (<relay-metrics-port>).
- **CNCLI 6.8.0 and Guild:** the `chain` and `blocklog` schemas, the leaderlog/validate journal lines and the Guild env layout are unchanged.

The real findings fall into four groups:
- **One DEGRADED Logs-tab problem,** made visible by today's restart: a line cap before the filter means the Logs tab can't see a BP restart more than about 20 minutes old.
- **One DEGRADED db-sync performance problem:** `epoch` is now a view, adding about 2.4 s to each delegator deep-dive.
- **One DEGRADED Ideal/Luck problem** (D3, pre-existing, found in the manual test): Ideal is computed from the Go stake snapshot instead of Set, so it showed 0.82 instead of 0.98 for epoch 657.
- **Several AT RISK items** that don't affect your setup today but will hit public users or the later db-sync host upgrade. The main ones:
  - the new Guild env version gate is swallowed silently;
  - CLI calls have no timeout;
  - silent fallbacks can show a zero or a neutral score instead of an error;
  - the version badge can read the wrong node process.
- **No declared supported versions** anywhere in the repo, and `HARDFORK.md` is stale.

`leadership-schedule` could not be captured, because it needs the VRF signing key. It is rated OK on the evidence that cli 11.2.3.0 keeps the same flags (help text captured) and upstream shows no change to its JSON output. The manual test run is the real check.

The VM relay was not captured. Its code path is the same as the BP host's relay's, which passed.

## 2. Findings

Severity: **BROKEN** = feature fails; **DEGRADED** = works but wrong, incomplete or slow; **AT RISK** = fine on this setup, fails on a plausible one; **OK** = checked and compatible.

### DEGRADED

#### D1. Logs tab: "Restarts & startup", "Errors & warnings" and "Rollbacks" presets

- **Where:** `src/views/logs.js:67-75` and `:202-208`
- **Problem:** the command is `journalctl -u <unit> --since "<window>" -n 5000 | grep -E <pattern>`. The `-n 5000` cap applies *before* the grep. The BP logs about 2,300 lines every 10 minutes (Forge.Loop and Forge.StateInfo at 1 Hz each, plus Mempool.AddedTx), so 5,000 lines reach back only about 21 minutes. The nominal windows are 24 hours and 14 days.
- **Evidence:** the node process was 3,531 s old when captured (`ETIMES=3531`), so it restarted for 11.1.2 about an hour earlier, yet `preset 'restart' unit=<bp-instance>.service window=336h ... matches=0`. The namespace counts for the last 10 minutes were `600 Forge.StateInfo.StateInfo`, `600 Forge.Loop.StartLeadershipCheck`, `600 Forge.Loop.NodeNotLeader` and `277 Mempool.AddedTx`.
- **Proposed fix:** filter before capping. Use `journalctl ... --since X -g '<pattern>' -n <cap>` (journalctl's own grep), and fall back to `... --since X | grep -E pat | tail -n cap` where journalctl was built without PCRE2. This is a pre-existing bug that today's restart exposed.

#### D2. DELEGATORS deep-dive (account summary and stake history), db-sync source

- **Where:** `src/data/dbsync-query.js:812`, `:818` and `:1085`
- **Problem:** db-sync 13.7.2.1 (schema 15.50.6) made `epoch` a VIEW, measured on the db-sync host as `epoch VIEW` over `epoch_finalized BASE TABLE`. `getAccountNow` reads `(SELECT MAX(no) FROM epoch)` twice, and the stake-history query has `JOIN epoch e ON e.no = b.epoch_no` but uses only `e.no`, which is the same value as `b.epoch_no`.
- **Evidence:** measured on the db-sync host:

  | query | time |
  |---|---|
  | `SELECT MAX(no) FROM epoch` | 795.7 ms |
  | `SELECT MAX(no) FROM epoch_finalized` | 0.3 ms |
  | `SELECT epoch_no FROM block ORDER BY id DESC LIMIT 1` | 1.1 ms |

  That is about 1.6 s per deep-dive from the two reads alone, plus the join.
- **Proposed fix:**
  - In `:812` and `:818`, replace `MAX(no) FROM epoch` with `(SELECT epoch_no FROM block ORDER BY id DESC LIMIT 1)`. Don't use `epoch_finalized`: it stops at 656, one short of the current epoch, so the spendable test would be off by one.
  - In `:1085`, drop the join and use `b.epoch_no`.
  - `getNetBlocks` (`:145`) runs once per session; leave it.

#### D3. Ideal and Luck use the Go stake snapshot instead of Set

- **Where:** `src/data/live.js:203-210` (before the fix), and `src/data/read-model.js:698-710`, which caches that Ideal and its Luck in the current epoch's History row.
- **Problem:** Ideal was σ × 21600 with σ = `stakeGo` pool / `stakeGo` total. The code comment claimed Go was the current epoch's leader stake, with Set being the next epoch's. That is backwards. Set drives leader election in the current epoch, Mark in the next, and Go is the older snapshot used for the reward calculation. Luck on the NOW card (adopted / Ideal) and the current epoch's History row inherited the error. This is a pre-existing bug, not an 11.1.2 change. The size and sign of the error depend on how much the pool's stake moved between the two snapshots.
- **Evidence:**
  - **Manual test, item 4:** the app showed Ideal 0.82 for epoch 657, and gLiveView and cncli showed 0.98.
  - **Captured `query stake-snapshot`, epoch 657:**

    | snapshot | Ideal (σ × 21600) |
    |---|---|
    | Set | **0.98** |
    | Mark | 0.97 |
    | Go (what the app used) | 0.82 |

    The pool's Set/Go stake ratio is 1.198, while the network totals differ by less than 0.1%. So 0.98 / 0.82 is almost entirely this pool's own stake change.
  - **cncli leaderlog on the BP:** `Ideal slots for epoch based on active stake: 0.98` for 657 and `0.97` for 658. The 658 value is today's Mark, which becomes Set at the boundary.
  - **gLiveView:** its Ideal is "based on active stake (sigma)", and the active stake it reads is Koios `pool_info.active_stake`. That value equals `stakeSet` in the capture, and differs from both Go and Mark.
  - **cardano-ledger source (Shelley rules):** `Rules/Snap.hs` rotates the snapshots at the boundary (`_pstakeMark = istakeSnap`, `_pstakeSet = _pstakeMark s`, `_pstakeGo = _pstakeSet s`). `Rules/NewEpoch.hs` then sets the leader-election distribution `nesPd` from `pd' = calculatePoolDistr (_pstakeSet ss)`.
  - **Unaffected:**
    - History rows for closed epochs from Koios `pool_history`, db-sync `epoch_stake` and Blockfrost, all of which are keyed by the epoch in which the stake is active;
    - the Delegators "Active stake" card (Koios `active_stake`, already labelled "set snapshot");
    - Leader (`leadership-schedule --current` picks the snapshot inside cardano-cli);
    - Pulse, which uses no stake snapshot.
- **Proposed fix:** read `stakeSet` (item 14), and correct the History rows already cached with the Go-based value (item 14b).

### AT RISK

#### A1. Connect / resume when Guild scripts are updated before the node

- **Where:** `src/views/connect.js:309-338` and `:478-536`
- **Problem:** Guild alpha `env` (commit bbaa6b0d, 23 Sept) runs `return 1` at env:1078 if node < 11.1.2 or cli < 11.2.3. That happens *after* `CCLI` is set but *before* `CARDANO_NODE_SOCKET_PATH`, `NETWORK_IDENTIFIER`, `POOL_ID` and the genesis variables. The probe sends the env's output to `/dev/null` and requires only `__PROBE_OK__` and `CCLI`, then quietly defaults the socket and `--mainnet`. The result is a "connected" session with an empty `POOL_ID`: no Ideal, `leadership-schedule --stake-pool-id` gets an empty value, and Guild's upgrade message is never shown.
- **Evidence:** the BP env is the older version (`1082:if ! versionCheckNode "11.0.1" ...`, `[env return code 0]`), so this setup is not affected today. The gate text is at bbaa6b0d env:1078-1082.
- **Proposed fix:** echo the env's return code and last lines as part of the probe. Fail the connect with that text when the code is non-zero or `POOL_ID` is empty on a BP.

#### A2. Every cardano-cli call: tip (1 s), mempool, KES, stake-snapshot, leadership-schedule

- **Where:** `src/data/live.js:69-72`, `src/data/read-model.js:167-170`, `src-tauri/src/ssh.rs:441-483`
- **Problem:** there is no timeout anywhere, neither in the command nor in `ssh_run`/`local_run`. cardano-cli#1434: cli 11.1.0.0 to 11.2.2.0 against node 11.0.x waits forever on `query tip` and `kes-period-info`. The in-flight guards then hold, so the dashboard freezes with no error.
- **Evidence:** the BP pair is 11.1.2 with 11.2.3.0 (captured `cardano-cli 11.2.3.0 ... git rev fef83fed`), which is fixed. The risk is public users, and the db-sync host if its cli is upgraded before its node.
- **Proposed fix:** prefix CLI commands with `timeout 10`, or 150 for `leadership-schedule`. Surface exit code 124 as "cardano-cli timed out (check the cli/node version pair)".

#### A3. Mempool panel: silent fallback

- **Where:** `src/data/live.js:486-489`
- **Problem:** on any failure `getMempool` returns `emptyMempool()`, which is `txCount: 0, totalBytes: 0`. That shows a real-looking empty mempool instead of an error, against the DESIGN rule "never show a 0 that could be mistaken for a reading".
- **Evidence:** not triggered in the capture (`numberOfTxs: 5`). This is a code-path finding.
- **Proposed fix:** return `null` or `{ error }` on failure and let the panel keep its loader or show "unavailable".

#### A4. Pool Pulse score: silent fallback

- **Where:** `src/data/live.js:101-109` and `:313-320`
- **Problem:** if `kes-period-info` fails on a BP, `kesDaysRemaining` goes to null and Pulse awards the "neutral 25" meant for relays. A BP whose KES check is failing therefore scores almost the same as a healthy one.
- **Evidence:** the KES query succeeded in the capture (43 periods). This is a code-path finding.
- **Proposed fix:** only give the neutral score when `probe.role !== 'BP'`. On a BP with a failed KES query, score 0 and flag it.

#### A5. Tickertape node-version badge

- **Where:** `src/main.js:358`
- **Problem:** candidate 1 is `pgrep -f 'cardano-node run' | head -1`.
  - On the BP host it returned the **relay** (`<relay's PID> ... <relay-instance> ...`), not the BP (the BP's PID).
  - On the db-sync host it matched nothing, because of `+RTS -N6 -RTS run` (`/proc/exe: No such file or directory`).
  
  Today the version is right only because both nodes share one binary. During a staged upgrade (one node first) the badge would show the wrong version.
- **Evidence:** the capture's `pgrep` listing and the version section.
- **Proposed fix:** try the probed PID (candidate 2) first; keep the others as fallbacks.

#### A6. Prometheus port discovery (BP and relay tabs)

- **Where:** `src/data/node-probe.js:173`, `src/data/relay-probe.js:100`
- **Problem:** the Prometheus port is taken to be the first TCP listener of the node PID that isn't the `--port` value. That works on the BP host (BP: <bp-metrics-port> vs <bp-port>; relay: <relay-metrics-port> vs <relay-port>) and the db-sync host. But the db-sync host has no `--port`, so nothing is excluded and `ss` ordering alone decides. Any extra listener would be scraped as Prometheus and fail silently: `curl -sf` returns empty, the panel says "Prometheus disabled". Examples are a cardano-rpc TCP endpoint (new in 11.x) or a node started without `--port`.
- **Evidence:** in the capture, BP listeners are `127.0.0.1:<bp-metrics-port>` and `0.0.0.0:<bp-port>`; relay listeners are `127.0.0.1:<relay-metrics-port>` and `0.0.0.0:<relay-port>`.
- **Proposed fix:** try each candidate port and pick the one whose `/metrics` contains `blockNum`. Also change the "Prometheus disabled" text to "no metrics endpoint found" when a scrape fails.

#### A7. All metric panels (peers, health, forge, propagation, relay cards)

- **Where:** `src/data/metrics-query.js:69-107`, `src/data/relay-probe.js:212-236`
- **Problem:** the `cardano_node_metrics_` prefix is hard-coded. An operator whose config sets a different `TraceOptionMetricsPrefix` gets all-null panels with no error. 11.1 now appends a missing trailing dot to the prefix, which changes the generated names for some custom configs.
- **Evidence:** the BP host and the db-sync host both use `cardano_node_metrics_` (119, 103 and 120 metric lines, and every app metric matched).
- **Proposed fix:** derive the prefix once per scrape from the line matching `^(\S*)blockNum_int ` and use it for every name.

#### A8. Heartbeat bootstrap (cncli.db) and Blocks minted (blocklog.db)

- **Where:** `src/views/connect.js:331-333` and `:510-512`, `src/data/live.js:417-425`, `src/views/logs.js:36-37` and `:311-313`
- **Your question: `CNCLI_DB` is empty, and that is normal.** Guild never sets it in `env`. It is set inside `cncli.sh:228-230` as `${CNCLI_DIR:-$CNODE_HOME/guild-db/cncli}/cncli.db`. PoolTerminal copies that default at connect.js:331 and 510, which gives `/opt/cardano/<bp-instance>/guild-db/cncli/cncli.db`. The capture read that file successfully (schema has `slot_number` and `orphaned`).
  - **What depends on it:** only the one-off heartbeat backfill (`getChainPulse`). On failure it silently returns an empty heartbeat.
  - **Gaps:**
    - a `CNCLI_DIR` override in `cncli.sh` is ignored;
    - blocklog uses `$CNODE_HOME/guild-db/blocklog/blocklog.db` instead of the `BLOCKLOG_DB` that `env` actually exports (env:1168-1169);
    - `live.js:420` opens cncli.db without `-readonly`.
- **Proposed fix:**
  - add `BLOCKLOG_DB` to the probe echo and use it when set;
  - add `-readonly` at `live.js:420`;
  - note the `CNCLI_DIR` limitation in the Logs config hint.

#### A9. Logs presets on nodes logging in machine (JSON) format

- **Where:** `src/views/logs.js:94-135`
- **Problem:** the patterns assume the human format `[ts][host:NS](Severity,n)`, which the BP uses. On a JSON-format node the patterns misbehave:
  - `\((Warning|Error|Critical)` can never match;
  - "Restarts & startup" matches ordinary fork-switch lines.
- **Evidence:** on the db-sync host (JSON): `errwarn ... matches=0`, and `restart ... matches=5`, all `ChainDB.AddBlockEvent.SwitchedToAFork` lines. The BP (human format) uses `(Info,98)`, `(Notice,76)`, so the patterns are right for it.
- **Proposed fix:** detect the format from the first line (a leading `{"at":`). For JSON, use `"sev":"(Warning|Error|Critical)"` and namespace patterns (e.g. `"ns":"Startup\.`).

#### A10. 1 Hz tip loop latency

- **Where:** `src/data/live.js:326`
- **Problem:** cli 11.2.2.0 and later first queries the genesis to validate the network id, adding a round trip to every query. It wasn't timed in the capture.
- **Evidence:** upstream only (cardano-cli 11.2.2.0 changelog).
- **Proposed fix:** measure it (checklist item 2). If it's material, pass `--socket-path` and consider a longer tip interval. No code change until it's measured.
- **Measured (added 25 September 2026):** `docs/audit/timing-bp.sh` ran each query the app uses 3 times on the block producer (node 11.1.2 / cli 11.2.3.0), niced, 2 s apart. All exits were 0.

  | query | run 1 | run 2 | run 3 |
  |---|---|---|---|
  | `query tip` | 14 ms | 14 ms | 14 ms |
  | `query tx-mempool info` | 14 ms | 15 ms | 15 ms |
  | `query kes-period-info` | 25 ms | 25 ms | 25 ms |
  | `query stake-snapshot` (one pool) | 15 ms | 15 ms | 15 ms |

  The same script on the 11.0.1 baseline node (cli 11.0.0.0) gave 14-15 ms for tip, mempool and stake-snapshot (kes-period-info not applicable, no op cert).
- **Conclusion: OK, no change needed.** Tip takes 14 ms on cli 11.2.3.0, the same as 14-15 ms on cli 11.0.0.0, so the network-id check added in 11.2.2.0 costs nothing measurable and the 1 Hz tip loop keeps ample headroom.

### OK

#### O1. cardano-cli JSON output: tip, mempool, stake-snapshot, KES

- **Where:** `src/data/live.js:194-201`, `:254-311`, `:326-330` and `:468-481`
- **Evidence:**
  - Tip: `{"block": 13982885, "epoch": 657, "era": "Conway", ..., "slotInEpoch": 239315, "slotsToEpochEnd": 192685, "syncProgress": "100.00"}`, with the same keys as 11.0.1.
  - Mempool: `"capacityInBytes": 67172352, "numberOfTxs": 5, "sizeInBytes": 3591`.
  - Stake-snapshot: `"pools": {"<pool-id>": {"stakeGo": …, "stakeMark": …, "stakeSet": …}}, "total": {` the same three keys `}`. The shape is compatible, but the app read the wrong one of the three (D3).
  - KES: two `✓` lines then JSON with every `qKes*` field the app reads.
  - Nothing on stderr; exit 0 throughout.
- **Proposed fix:** none.

#### O2. `query leadership-schedule`

- **Where:** `src/data/read-model.js:578-635`
- **Evidence:** not captured (needs the VRF skey). The help text still shows `--genesis`, `--stake-pool-id`, `--vrf-signing-key-file`, `(--current | --next)` and `--output-json` (the default). The diff against 11.0.0.0's help is whitespace only. The genesis the app derives exists: `.../files/shelley-genesis.json exists=yes`.
- **Proposed fix:** confirm in the manual test (checklist item 5).

#### O3. Prometheus metric names

- **Where:** `src/data/metrics-query.js:69-107`, `src/data/relay-probe.js:212-236`
- **Evidence:**
  - All 25 names are present on the BP.
  - Relay: all present except the forge set, which is expected on a relay.
  - The only name differences between the 11.0.1 and 11.1.2 sets are role- or uptime-dependent series: churn `_duration_real`, `localInboundGovernor_*` and `txsMempoolTimeoutSoft_counter`. The app reads none of them.
  - No EKG use anywhere.
  - Sample BP values: `inboundConns 3, outboundConns 2, blocksForged 0, Forge_about_to_lead_counter 3482, slotsMissed 0`.
- **Proposed fix:** none. The forge counters restart from 0 when the node restarts (process-lifetime counters), as before.

#### O4. Node role, op-cert and VRF path discovery

- **Where:** `src/data/node-probe.js:160-215`
- **Evidence:** The BP's PID was found from the socket, with the `--shelley-*` arguments present, so role = BP. The relay loop picked the relay (KES=0) on the two-node host.
- **Proposed fix:** none.

#### O5. CNCLI 6.8.0 and Guild blocklog

- **Where:** `src/views/logs.js:159-193`
- **Evidence:** blocklog columns are unchanged, with rows in `confirmed`, `ghosted`, `stolen` and `leader` statuses. The leaderlog and validate lines have the same format, e.g. `LEADER: slot[<slot>] slotInEpoch[<n>] at[<time>]` and `CONFIRMED: Leader for slot '<slot>' ...`. Unit names `<bp-instance>-cncli-leaderlog.service` and `<bp-instance>-cncli-validate.service` match what the app derives.
- **Proposed fix:** none.

#### O6. KES preset in the Logs tab

- **Where:** `src/views/logs.js:111-119`
- **Evidence:** `KES info startPeriod <start> currPeriod <current> endPeriod <end>, <n> KES periods until expiry.` It matches (tail 1), and the value agrees with the CLI.
- **Proposed fix:** none.

#### O7. db-sync schema gate

- **Where:** `src/data/dbsync-query.js:24`
- **Evidence:** installed `15.50.6` against `DBSYNC_TESTED_SCHEMA = '15.44.6'`. The app already shows "(tested 15.44.6 - verify)". This predates today's upgrade and is not caused by the node.
- **Proposed fix:** bump the constant once the delegator and history screens pass the manual test on 15.50.6.

## 3. Watch list: when the db-sync host, db-sync or Ogmios move to 11.1.x

- **Upgrade order on the db-sync host.** Upgrade node and cli together, or the node first:
  - a cli from 11.1.0.0 to 11.2.2.0 against node 11.0.1 hangs (A2);
  - pulling the Guild alpha `env` before the node trips its gate (A1). Any `cnode` scripts on the db-sync host that source env would stop too.
- **db-sync release for 11.1.x.** Expect a new schema version, so re-run the delegator and history checks and then bump `DBSYNC_TESTED_SCHEMA`.
  - Re-verify the version-dependent tables and columns: `reward_rest`, `tx_out.consumed_by_tx_id`, `epoch_stake_progress`, `off_chain_pool_data`.
  - If `epoch` stays a view, D2's fix still applies. Note that the 13.7.2.1 migration's `DROP TABLE "epoch" CASCADE` removes dependent user views. PoolTerminal creates none, but check anything else on the db-sync host that has views over `epoch`.
- **Ogmios.** PoolTerminal doesn't use Ogmios (no port 1337 or Ogmios reference anywhere), so an Ogmios upgrade has no PoolTerminal impact.
- **The db-sync host's node logs JSON.** If PoolTerminal is ever pointed at it (local mode), A9 applies.
- **Ledger snapshot timing (11.1.x).** `SnapshotInterval` is now counted in slots on a fixed grid (Guild's 43200 is still about 12 hours). Snapshots and the major-GC sawtooth will line up with chain slots, not node start time, which shifts the phase of the propagation and GC pattern in NODE HEALTH. Expect it; don't treat it as a regression.
- **cardano-submit-api.** The BP reports `cardano-submit-api 11.1.1` (from a 11.1.2 build). PoolTerminal doesn't use it; noted only because it's on the host.

## 4. Declared supported versions

Right now nothing in the repo declares which versions are supported:
- README "Requirements" (README.md:116-125) says only "a running Cardano node with the standard Guild Operators tooling layout".
- About (`src/views/about.js:113-117`) talks about hard forks generically.
- `HARDFORK.md:13-18` is stale: "Node version target: 10.7.x (current mainnet: 10.5.4)", "PoolTerminal not yet released".

**Proposed declaration for the next release:**

| component | supported (tested) | notes |
|---|---|---|
| cardano-node | 11.1.2 (BP + relay, 24 Sept 2026); 11.0.1 | new tracing with PrometheusSimple; metrics prefix `cardano.node.metrics.` |
| cardano-cli | 11.2.3.x with node 11.1.x; 11.0.0.0 with node 11.0.1 | don't pair cli 11.1.0.0-11.2.2.0 with node 11.0.x (hangs) |
| cncli | 6.8.0; 6.7.0 | Guild cncli.sh layout (`guild-db/cncli/cncli.db`, `guild-db/blocklog/blocklog.db`) |
| Guild scripts | env with the 11.0.1 gate (tested); alpha bbaa6b0d (11.1.2 gate) | alpha not yet exercised by a test run |
| db-sync | 13.7.2.1, schema 15.50.6 | `DBSYNC_TESTED_SCHEMA` bumped from 15.44.6 after checklist items 11-13 passed |
| Ogmios | not used | - |

**Where it needs changing:**
1. README.md "Requirements": add the table, or a short list linking to it.
2. `src/views/about.js`: a "Tested with" line under the hard-fork paragraph.
3. `HARDFORK.md` "Currently active fork target": replace the 10.7.x / pre-release text.
4. `src/data/dbsync-query.js:24`: `DBSYNC_TESTED_SCHEMA`.
5. CHANGELOG.md, plus the release body (RELEASING.md's template), for the next tag.

A single `src/data/compat.js` constant, read by About and the DATA tab, would stop these drifting apart again. That's optional.

## 5. Manual test checklist (`cargo tauri dev`, connected to the BP)

1. **Connect with the BP profile** (host <bp-host>, 2FA, env `/opt/cardano/<bp-instance>/scripts/env`). Working looks like:
   - the role badge says BP;
   - the tickertape shows `node v11.1.2`;
   - devtools console `[node-probe] ... role=BP port=<bp-port> prom=<bp-metrics-port>`.
2. **DASHBOARD tip loop.** Working looks like:
   - epoch 657, slot and block advance every second;
   - AT TIP is shown;
   - no `ssh_run exit` warnings in the console.
   
   Optional (A10): in devtools, `performance.now()` around a tip refresh, or run `time cardano-cli query tip --mainnet` on the BP yourself. Well under 1 s is fine.
3. **KES / op-cert.** Working looks like:
   - the hourglass shows days and periods matching `cardano-cli query kes-period-info`;
   - the disk and chain op-cert counters are equal;
   - console `[live.kes] periods=43`.
4. **Ideal and block production card.** Working looks like:
   - console `[live.ideal] epoch 657: ... ideal=<value>`;
   - the card's Ideal and Leader (from `leadership-schedule`) match cncli's leaderlog figures; Luck and Adopted come from Koios.
   - *After 14/D3:* Ideal is 0.98 for epoch 657, matching cncli's "Ideal slots for epoch based on active stake" and gLiveView. The 0.82 seen in the first run was D3.
5. **Upcoming blocks panel.** Working looks like: your assigned slots for the current epoch, matching cncli's leaderlog. If it shows "Leadership schedule unavailable", copy the console `[read-model] leadership-schedule failed:` line; that is the one uncaptured CLI output.
6. **Mempool panel.** Working looks like:
   - a tx count and bytes against about 67 MB capacity;
   - the fill % is plausible;
   - the throughput sparkline moves (it uses `txsProcessedNum_counter`).
7. **Peers panel.** Working looks like:
   - header OUT 2, IN 3, BiDir 3, Duplex 1 (roughly; it varies);
   - the body lists the 4 relay sockets with RTTs;
   - console `[metrics] ... OUT 2 · IN 3`.
8. **NODE HEALTH.** Working looks like:
   - RSS about 8 GB, heap and GC figures present, CPU% and disk shown;
   - forge counters: Forged 0, Leader 0, Missed checks 0 of about 3.5k since restart;
   - propagation cdf <1s about 97%.
9. **RELAY 1 tab pointed at the BP host** (no selector) **and RELAY 2 at the VM relay.** Working looks like:
   - each shows node v11.1.2;
   - the BP host picks the relay (port <relay-port>, prom <relay-metrics-port>), not the BP;
   - tip, density, peers (about 75 out / 19 in on the BP host) and propagation are populated.
   
   The VM relay was not captured, so this is its first check.
10. **LOGS tab.**
    - Errors & warnings: empty or real lines.
    - KES status: one `KES info ... 43 KES periods until expiry` line.
    - Restarts & startup: **expect it to show nothing** for today's restart (D1). That confirms the bug and is not a new fault.
    - Leader slots (CNCLI): the 20 Sept leaderlog lines.
    - Block validation: the ADOPTED/CONFIRMED lines.
    - Blocks minted (Local): rows with confirmed / ghosted / stolen / leader statuses.
    - Blocks minted (db-sync): full history.
11. **HISTORY.** Working looks like: per-epoch rows back to the pool's first epoch from db-sync, with no "backfill failed" in the console. The DATA tab shows db-sync schema 15.50.6 with the "verify" note (expected).
12. **DELEGATORS and deep-dive.** Open one delegator. Working looks like: the account summary and stake history load. Note the load time, which is D2's cost: expect about 2 s now.
13. **NOTIFICATIONS.** Working looks like: the feed loads and there are no console errors from `getDelegationEvents`.
14. **Reload the webview** (resume without 2FA). Working looks like: console `[resume] reused existing session, env re-probed OK`.

**Result (25 Sept 2026): all 14 items pass** on the BP, and item 9 also on the VM relay. Item 4 passed after 14/D3, with Ideal 0.98 for epoch 657; the first run showed 0.82, which is how D3 was found. Items 11 to 13 passing cleared the `DBSYNC_TESTED_SCHEMA` bump to 15.50.6. The run turned up four follow-ups, items 15 to 18 in section 6:
- key and op-cert paths in the console;
- VM relay warm/cold peers shown as 0;
- no untested-schema note on the DATA tab, which is why item 11's expected "verify" note did not appear;
- mempool percentage labels.

## 6. Proposed fix plan (one commit each, in order; not implemented)

1. **Logs: filter before capping** (D1). In `logs.js` `journalCmd` / `:202-208`, use `journalctl -g` (or `| grep | tail -n cap`) so the 24-hour and 14-day windows really cover 24 hours and 14 days.
2. **db-sync: stop reading the `epoch` view in the deep-dive** (D2). `dbsync-query.js:812` and `:818` read the current epoch from `block`; `:1085` drops the join.
3. **Connect: make a failed Guild env visible** (A1). The probe echoes the env return code and last lines; connect and resume fail with that text on a non-zero code, or on an empty `POOL_ID` for a BP.
4. **CLI timeouts** (A2). `cliCmd` in `live.js` and `read-model.js` wraps with `timeout 10`, or 150 for leadership-schedule; exit 124 gives a clear message.
   - *As implemented (commit 4/A2):* per-command timeouts, set after the A10 timing run, defined once in `src/data/cli.js`: tip 10 s, mempool 10 s, kes-period-info 20 s, stake-snapshot 30 s, leadership-schedule 300 s. The slowest measured runs were tip 14 ms, mempool 15 ms, kes-period-info 25 ms and stake-snapshot 15 ms, so 3x the slowest run is under 0.1 s and every value is a floor, not a measurement: the stake-snapshot and leadership-schedule values are the agreed minimums, and leadership-schedule cannot be timed without the VRF signing key.
5. **Mempool: show "unavailable", not zeros** (A3). `live.js:486-489`.
6. **Pulse: no neutral KES score on a BP** (A4). `live.js:101-109`.
7. **Version badge: probed PID first** (A5). `main.js:358-363`.
8. **Prometheus port: verify by content** (A6). `node-probe.js:173`, `relay-probe.js:100`; fix the "Prometheus disabled" wording.
9. **Metric prefix auto-detect** (A7). `metrics-query.js`, `relay-probe.js`.
10. **cncli / blocklog paths and `-readonly`** (A8). Probe echoes `BLOCKLOG_DB`; `live.js:420` gets `-readonly`.
11. **Logs presets for JSON-format nodes** (A9). `logs.js:94-135`.
12. **Declared versions** (section 4). README, About, HARDFORK.md, CHANGELOG; bump `DBSYNC_TESTED_SCHEMA` once checklist items 11-13 pass.
13. **Housekeeping.**
    - Remove the stale "prunableConns" comment at `metrics-query.js:14`.
    - Fix the `txsProcessedNum_int` reference in `mempool.js:17`; the code reads `_counter`.
    - Fix the `cache.rs:10` doc-indent clippy warning.
14. **Ideal and Luck from the Set snapshot** (D3). New `src/data/stake-snapshot.js` computes σ from `pools[<id>].stakeSet` / `total.stakeSet`, falling back to cardano-cli 1.35.x's flat `poolStakeSet` / `activeStakeSet` keys (confirmed in that version's `Cardano/CLI/Types.hs`). `live.js` uses it, and every comment that called Go the current epoch's snapshot is corrected.
    - **14b, cached History rows:** a one-time pass (meta key `ideal_set_fix_v1`) rewrites every row still marked `source: 'live'`. The current epoch takes the corrected cli Ideal. Closed epochs are recomputed from the row's own Set `activeStakeLovelace` via `computeIdeal`, or reset to null for the fillers if that fails. Luck is recomputed with Ideal. New rows are correct at write time because the Ideal passed in is now Set-based.

## Appendix: build and static checks (Phase 5)

- `cargo check`: clean.
- `cargo clippy`: one warning, `doc list item overindented` at `src/cache.rs:10`. It's cosmetic and not relevant to this audit.
- `cargo test`: 0 tests in the crate (there is no test suite, as CLAUDE.md says).

There is no JS test suite. In its place, the app's own parsing expressions (`JSON.parse` offsets, stake-snapshot key paths, `qKes*` fields, the `readMetric` regex) were run over both capture files with Node. All parsed identically on 11.1.2 and 11.0.1. The stake-snapshot key path parsed correctly but read the wrong snapshot: it gives 0.82 on the 11.1.2 capture where Set gives 0.98 (D3). After 14/D3, `stake-snapshot.js` was run over the 11.1.2 capture with Node: Ideal is 0.98 with both the nested keys and cardano-cli 1.35.x's flat keys.
