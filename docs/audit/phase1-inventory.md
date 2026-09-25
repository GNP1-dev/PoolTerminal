# Phase 1 - external touchpoint inventory (PoolTerminal b176051, 2026-09-24)

Audit working file; the final report is `node-11.1.2-compat-2026-09-24.md`.
Every node command runs through `invoke('ssh_run')` (or `local_run` in local
mode, same `{stdout, stderr, exit_code}` shape - `src-tauri/src/ssh.rs:441-483`).
stderr is kept separate, so CLI warnings on stderr are harmless; warnings on
**stdout** break every `JSON.parse`. Only `live.js:55` and `read-model.js:155`
throw on a non-zero exit; the `runCmd` copies in metrics-query, node-probe,
peers-query, host-query, logs, geo-query and blockfrost-query ignore the exit
code and just read stdout.

## A. Guild env and process discovery

| file:line | what | exact command | how parsed |
|---|---|---|---|
| src/views/connect.js:309-324 (dup. 478-492) | Guild env probe | `cd <envdir> && { source ./<env> offline >/dev/null 2>&1; echo "__PROBE_OK__"; echo "CCLI=$CCLI"; ... }` - vars CCLI, CARDANO_NODE_SOCKET_PATH, CNODE_HOME, CNCLI, CNCLI_DB, NETWORK_NAME, NETWORK_IDENTIFIER, POOL_TICKER, POOL_ID, POOL_NAME, SHELLEY_GENESIS_START_SEC, SHELLEY_TRANS_EPOCH, BYRON_EPOCH_LENGTH, EPOCH_LENGTH | `KEY=value` lines; requires `__PROBE_OK__` and non-empty CCLI |
| src/views/connect.js:331-338, 510-536 | fallbacks | CNCLI_DB := `$CNODE_HOME/guild-db/cncli/cncli.db`; socket := `$CNODE_HOME/sockets/node.socket`; NETWORK_IDENTIFIER := `--mainnet` | string concat |
| src/data/node-probe.js:160-175 | node PID, args, ports | `fuser "$S"` / `ps -eo pid,args \| awk '/[c]ardano-node/ && index($0,"--socket-path " s)'`; `ps -p PID -o args=`; `grep -oP -- '--port[= ]+\K[0-9]+'`; `ss -tlnp \| grep "pid=$PID," \| ... \| grep -v "^$NODE_PORT$" \| head -1`; `ps -o etimes=` | KV lines; role = BP iff ` --shelley-kes-key ` in args; regexes `--port\s+(\d+)`, `--topology\s+(\S+)`, `--shelley-operational-certificate\s+(\S+)`, `--shelley-vrf-key\s+(\S+)`, `--config\s+(\S+)`; Prometheus port = **first** non-node-port TCP listener of the PID |
| src/data/relay-probe.js:96-104 | relay discovery (every node on host) | `for PID in $(pgrep -x cardano-node) ...` same ss/port logic, `KES=$(grep -c -- '--shelley-kes-key')`, `VER=$("$BIN" --version \| head -1)` | `@@NODE@@` blocks of KV; `cardano-node\s+(\S+)` for version |
| src/main.js:358-368 | node version badge | 1) `"$(readlink -f /proc/$(pgrep -f 'cardano-node run' \| head -1)/exe)" --version` 2) `/proc/<probe pid>/exe --version` 3) `$(dirname $CCLI)/cardano-node --version` 4) `cardano-node --version` | regex `/cardano-node\s+(\S+)/i` |

## B. cardano-cli (all via `CARDANO_NODE_SOCKET_PATH=<sock> $CCLI <args> $NETWORK_IDENTIFIER`, live.js:69-72, read-model.js:167-170)

| file:line | what | exact command | how parsed |
|---|---|---|---|
| src/data/live.js:326-330 | tip (1 s fast loop) | `query tip --mainnet` | `JSON.parse(stdout)` (whole stdout, no offset); fields `slotInEpoch`, `slotsToEpochEnd`, `syncProgress` (string -> parseFloat), `epoch`, `slot`, `block`, `era` |
| src/data/live.js:468-481 | mempool (5 s) | `query tx-mempool info --mainnet` | `JSON.parse(stdout)`; `sizeInBytes` (fallback `bytes`), `capacityInBytes`, `numberOfTxs` |
| src/data/live.js:194-203 | Ideal blocks (once/epoch) | `query stake-snapshot --stake-pool-id <POOL_ID hex> --mainnet` | JSON from first `{`; `pools[<POOL_ID>].stakeGo` else `poolStakeGo`; `total.stakeGo` else `activeStakeGo`. Wrong snapshot: Set is the current epoch's; fixed in 14/D3, which reads `stakeSet` via `stake-snapshot.js` |
| src/data/live.js:254-311 | KES + op-cert counters (60 s) | `query kes-period-info --op-cert-file '<op.cert from node args>' --mainnet` | JSON from first `{` (skips the checkmark lines); `qKesCurrentKesPeriod`, `qKesEndKesInterval`, `qKesSlotsPerKesPeriod`, `qKesOnDiskOperationalCertificateNumber`, `qKesNodeStateOperationalCertificateNumber`, `qKesKesKeyExpiry` (Date.parse) |
| src/data/read-model.js:593-613 | leader schedule (once/epoch; `--next` in window) | `query leadership-schedule --genesis '<dir of --config>/shelley-genesis.json' --stake-pool-id <hex> --vrf-signing-key-file '<vrf from node args>' --current\|--next --mainnet` | `--next` "not ready" by regex `/not.*stabilis\|expected.*current\|TooEarly\|StakeSnapshot/i` on stdout; JSON array from first `[` -> `slotNumber` (or `slot`), `slotTime`; text fallback `/^\s*(\d{6,})\s+(.+?)\s*$/` |

## C. Prometheus (curl on the node)

| file:line | what | command | metric names (regex `^<name>\s+([\d.eE+\-]+)` - no label sets allowed) |
|---|---|---|---|
| src/data/metrics-query.js:56-107 | BP peers / health / forge / propagation (5 s) | `curl -sf --max-time 3 http://127.0.0.1:<probed port>/metrics` | `cardano_node_metrics_` + `connectionManager_{inbound,outbound,unidirectional,duplex,fullDuplex}Conns_int`, `peerSelection_{Cold,Warm,Hot}_int`, `txsProcessedNum_counter`, `Mem_resident_int`, `RTS_gcLiveBytes_int`, `RTS_gcHeapBytes_int`, `Stat_cputicks_int`, `density_real`, `slotNum_int`, `blockNum_int`, `mempoolBytes_int`, `txsInMempool_int`, `blocksForged_int`, `nodeCannotForge_int`, `nodeIsLeader_int`, `slotsMissed_int`, `Forge_about_to_lead_counter`, `blockfetchclient_blockdelay_{cdfOne,cdfThree,cdfFive}_real`, `blockfetchclient_blockdelay_real` |
| src/data/relay-probe.js:205-236 | relay card | same curl | as above plus `epoch_int`, `slotInEpoch_int` |
| src/data/peers-query.js:62, relay-probe.js:269 | peer list | `ss -tnpi state established` | lines containing `pid=<PID>,`; IPv4 regex; `\srtt:([\d.]+)\/` on next line |

## D. CNCLI / Guild SQLite (sqlite3 on the node)

| file:line | what | command | parsed |
|---|---|---|---|
| src/data/live.js:417-425 | heartbeat bootstrap | `sqlite3 $CNCLI_DB "SELECT slot_number FROM chain WHERE orphaned = 0 AND slot_number > N ORDER BY slot_number ASC"` (note: **not** `-readonly`) | one integer per line |
| src/views/logs.js:185-193 | Blocks minted (local) | `nice -n 19 ionice -c3 sqlite3 -readonly -separator '\t' <blocklog.db> "SELECT status, COUNT(*) FROM blocklog GROUP BY status ..."` then `SELECT epoch, slot_in_epoch, at, status, block, size, substr(hash,1,12) FROM blocklog ORDER BY slot DESC` | tab-separated columns by position |
| src/views/logs.js:36-37, 299-313 | default paths | unit `<basename CNODE_HOME>.service`, db `$CNODE_HOME/guild-db/blocklog/blocklog.db` | - |

## E. journalctl (Logs tab, display only - lines are shown, not parsed into values)

| file:line | preset | unit | filter on node |
|---|---|---|---|
| src/views/logs.js:64-75 | all | - | `nice -n 19 ionice -c3 journalctl -u <unit> --no-pager --merge --since "<h> hours ago" -n <cap>` |
| logs.js:94-102 | errwarn | BP | `grep -E '\((Warning\|Error\|Critical)'` |
| logs.js:103-110 | recent | BP | `grep -vE 'Net\.Mux\.Local\|StateQueryServer\|LocalHandshake\|Forge\.Loop\.StartLeadershipCheck\|Forge\.Loop\.NodeNotLeader\|Forge\.StateInfo\.StateInfo\|Mempool\.AddedTx'` |
| logs.js:111-119 | kes | BP | `KES info\|OperationalCertificate\|ExpiryLog` |
| logs.js:120-127 | restart | BP | `Node version\|cardano-node [0-9]\|Started opening\|Chain DB\|Byron\|Shelley\|Conway\|Started blockchain` |
| logs.js:128-135 | rollback | BP | `SwitchedToAFork\|Rollback\|RolledBack\|switched to a fork` |
| logs.js:159-167 | leader | `<stem>-cncli-leaderlog.service` | `LEADER:\|Leaderslots:\|Leaderlog calculation` |
| logs.js:168-176 | validate | `<stem>-cncli-validate.service` | `adopted\|confirmed\|missed\|ADOPTED\|...` |

## F. db-sync (tokio-postgres, `src-tauri/src/pg.rs`; every column `::text`)

| file:line | what | SQL | notes |
|---|---|---|---|
| src/data/dbsync-query.js:24, 1157-1159 | schema gate | `SELECT stage_one, stage_two, stage_three FROM schema_version` | `DBSYNC_TESTED_SCHEMA = '15.44.6'`; installed on the db-sync host = **15.50.6** -> `schemaStale()` true |
| dbsync-query.js:145 | network blocks/epoch | `SELECT no, blk_count FROM epoch WHERE no BETWEEN f AND t` | `epoch` is a VIEW on 13.7.2.1 |
| dbsync-query.js:812, 818 | account spendable rewards | `(SELECT MAX(no) FROM epoch)` x2 | VIEW |
| dbsync-query.js:1085 | stake-history withdrawals | `JOIN epoch e ON e.no = b.epoch_no` (only `e.no` used) | VIEW; join is redundant (`b.epoch_no` already present) |
| dbsync-query.js (other) | history, delegators, rewards, blocks | pool_hash, slot_leader, block, epoch_stake, epoch_stake_progress, reward, reward_rest, pool_update, pool_owner, stake_address, tx_out/tx_in, withdrawal, delegation, off_chain_pool_data | not node-version sensitive |

## G. External APIs (not node-version dependent)

| file:line | what | transport |
|---|---|---|
| src/data/koios-query.js:35, koios-history.js:37 | Koios v1: pool_info, pool_history, pool_blocks, pool_delegators, pool_updates, epoch_info, account_info, account_history, account_rewards, tip | direct HTTPS from the desktop via `src-tauri/src/http.rs:12` (`koios_http`); bearer from koios-token.js |
| src/data/blockfrost-query.js:29, 53 | Blockfrost v0: pools/{id}[/history,/delegators,/updates,/retirements,/metadata], accounts/{s}[/history,/delegations], epochs/{n}, blocks, health | **curl on the node** over ssh_run |
| src/data/geo-query.js:90, 141 | ip-api.com | curl on the node |

## H. Not used

No Ogmios / port 1337, no cardano-submit-api, no gLiveView or cntools.sh calls,
no EKG, no `jq`, no `query protocol-parameters` (HARDFORK.md mentions it but no
code runs it). the node and metrics port numbers are never hard-coded: the Prometheus port is
always auto-detected from `ss`.
