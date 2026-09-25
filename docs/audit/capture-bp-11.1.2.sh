#!/usr/bin/env bash
# PoolTerminal compatibility audit - read-only capture of node / cli / cncli output.
# 2026-09-24, for the cardano-node 11.1.2 upgrade audit.
#
# READ-ONLY. Designed to be piped over SSH so nothing is written on the target:
#   ssh <user>@<bp-host> 'bash -s' < docs/audit/capture-bp-11.1.2.sh > docs/audit/capture-bp-11.1.2.txt 2>&1
# For a non-stock layout pass the env: 'bash -s -- --env /opt/cardano/<bp-instance>/scripts/env'
#
# Every command below is one PoolTerminal itself runs (same flags), plus version
# banners and full Prometheus dumps. Nothing here signs, submits, registers,
# votes or reads a signing key. `query leadership-schedule` is deliberately
# ABSENT: it needs --vrf-signing-key-file, so it cannot be captured under the
# audit rules. `query kes-period-info` reads the operational certificate (not a
# signing key) and is OFF unless you pass --with-kes:
#   ssh <user>@<bp-host> 'bash -s -- --with-kes' < ... > ...
# Paths of --shelley-* arguments are redacted from every process listing.
#
# Options (all optional):
#   --env PATH          Guild env file   (default: Guild stock /opt/cardano/cnode/scripts/env)
#   --unit NAME         BP systemd unit  (default: <basename of CNODE_HOME>.service, as the app derives it)
#   --metrics-port N    Prometheus port to dump, repeatable (default: every cardano-node's own
#                       metrics port on this host, found as the app finds it)
#   --with-kes          also run `query kes-period-info` against the running node's op cert
#   --pool-id HEX       use this pool id when the env has no POOL_ID (baseline runs only)

# no `set -u`: the Guild env references unset variables and would abort the script
ENV_FILE=/opt/cardano/cnode/scripts/env
UNIT=
PORTS=()
WITH_KES=0
POOL_ID_ARG=
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE=$2; shift 2 ;;
    --unit) UNIT=$2; shift 2 ;;
    --metrics-port) PORTS+=("$2"); shift 2 ;;
    --with-kes) WITH_KES=1; shift ;;
    --pool-id) POOL_ID_ARG=$2; shift 2 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done

hdr() { printf '\n==================== %s ====================\n' "$*"; }
redact() { sed -E 's/(--shelley-(kes-key|vrf-key|operational-certificate)[= ]+)[^ ]+/\1<redacted>/g'; }
# Run a command, labelling stderr lines and printing the exit code, with no temp files.
run() {
  echo "\$ $*" | redact
  { eval "$@" 2>&1 1>&3 3>&- | sed 's/^/[stderr] /'; } 3>&1
  echo "[exit ${PIPESTATUS[0]}]"
}

hdr "capture meta"
echo "host=$(hostname) date=$(date -u +%FT%TZ) env=$ENV_FILE with_kes=$WITH_KES"

# ---- 1. Guild env probe (src/views/connect.js:309-324, identical command) ----
hdr "env probe (connect.js resumeLive/showConnectModal)"
ENV_DIR=$(dirname "$ENV_FILE"); ENV_NAME=$(basename "$ENV_FILE")
cd "$ENV_DIR" || { echo "cannot cd $ENV_DIR"; exit 1; }
# The app discards this output (>/dev/null). Show it once, in a subshell, with the
# return code: Guild alpha env (bbaa6b0d) returns 1 on a node/cli version gate
# before exporting the socket, network and pool variables.
echo "-- env version gate lines:"; grep -n 'versionCheckNode "' "./$ENV_NAME"
echo "-- env's own output when sourced (subshell):"
( source "./$ENV_NAME" offline; echo "[env return code $?]" ) 2>&1 | tail -15
# shellcheck disable=SC1090
{ source "./$ENV_NAME" offline >/dev/null 2>&1; echo "__PROBE_OK__"; }
for v in CCLI CARDANO_NODE_SOCKET_PATH CNODE_HOME CNCLI CNCLI_DB NETWORK_NAME NETWORK_IDENTIFIER \
         POOL_TICKER POOL_ID POOL_NAME SHELLEY_GENESIS_START_SEC SHELLEY_TRANS_EPOCH BYRON_EPOCH_LENGTH EPOCH_LENGTH; do
  echo "$v=${!v:-}"
done
# App-side fallbacks (connect.js:331-338)
: "${CNCLI_DB:=${CNODE_HOME:-}/guild-db/cncli/cncli.db}"
: "${CARDANO_NODE_SOCKET_PATH:=${CNODE_HOME:-}/sockets/node.socket}"
: "${NETWORK_IDENTIFIER:=--mainnet}"
echo "effective CNCLI_DB=$CNCLI_DB socket=$CARDANO_NODE_SOCKET_PATH net=$NETWORK_IDENTIFIER"
NET=$NETWORK_IDENTIFIER
[ -z "${POOL_ID:-}" ] && [ -n "$POOL_ID_ARG" ] && { POOL_ID=$POOL_ID_ARG; echo "POOL_ID taken from --pool-id=$POOL_ID"; }
cli() { echo "\$ CARDANO_NODE_SOCKET_PATH=\$S \$CCLI $* $NET"; { CARDANO_NODE_SOCKET_PATH=$CARDANO_NODE_SOCKET_PATH "$CCLI" "$@" $NET 2>&1 1>&3 3>&- | sed 's/^/[stderr] /'; } 3>&1; echo "[exit ${PIPESTATUS[0]}]"; }

# ---- 2. Node probe (src/data/node-probe.js:160-175, same logic) ----
hdr "node probe (node-probe.js)"
S=$CARDANO_NODE_SOCKET_PATH
PID=$(fuser "$S" 2>/dev/null | tr -d ' \n')
[ -z "$PID" ] && PID=$(ps -eo pid,args 2>/dev/null | awk -v s="$S" '/[c]ardano-node/ && index($0, "--socket-path " s) { print $1; exit }')
echo "PID=$PID"
ARGS=$(ps -p "$PID" -o args= 2>/dev/null)
echo "ARGS=$ARGS" | redact
NODE_PORT=$(echo "$ARGS" | grep -oP -- '--port[= ]+\K[0-9]+')
echo "NODE_PORT=$NODE_PORT"
echo "PROM_PORT(app pick)=$(ss -tlnp 2>/dev/null | grep "pid=$PID," | awk '{print $4}' | awk -F: '{print $NF}' | grep -v "^$NODE_PORT$" | head -1)"
echo "-- all TCP listeners of PID $PID (app takes the first non-node-port one):"
ss -tlnp 2>/dev/null | grep "pid=$PID,"
echo "ETIMES=$(ps -o etimes= -p "$PID" 2>/dev/null | tr -d ' ')"
for f in shelley-kes-key shelley-vrf-key shelley-operational-certificate config topology; do
  echo "arg --$f present: $(echo " $ARGS " | grep -c -- " --$f ")"
done
CONFIG=$(echo "$ARGS" | grep -oP -- '--config\s+\K\S+')
echo "config=$CONFIG ; genesis the app derives: $(dirname "$CONFIG")/shelley-genesis.json exists=$([ -f "$(dirname "$CONFIG")/shelley-genesis.json" ] && echo yes || echo no)"

# ---- 3. Versions (main.js:358-363, relay-probe.js:103) ----
hdr "versions"
run "\"\$(readlink -f /proc/\$(pgrep -f 'cardano-node run' | head -1)/exe)\" --version"
echo "-- pgrep -f 'cardano-node run' matches (main.js takes head -1):"
pgrep -af 'cardano-node run' | redact
run "\"\$(readlink -f /proc/$PID/exe)\" --version"
run "\"$CCLI\" --version"
run "\"\$(dirname \"$CCLI\")/cardano-node\" --version"
run "\"${CNCLI:-cncli}\" --version"
run "command -v cardano-submit-api && cardano-submit-api --version"

# ---- 4. cardano-cli queries the app runs ----
hdr "query tip (live.js:326, JSON.parse on whole stdout)"
cli query tip
hdr "query tx-mempool info (live.js:468, JSON.parse on whole stdout)"
cli query tx-mempool info
hdr "query stake-snapshot (live.js:194)"
if [ -n "${POOL_ID:-}" ]; then cli query stake-snapshot --stake-pool-id "$POOL_ID"; else echo "POOL_ID empty - skipped"; fi
hdr "query kes-period-info (live.js:254)"
OPCERT=$(echo "$ARGS" | grep -oP -- '--shelley-operational-certificate\s+\K\S+')
if [ "$WITH_KES" = 1 ] && [ -n "$OPCERT" ]; then
  echo "\$ CARDANO_NODE_SOCKET_PATH=\$S \$CCLI query kes-period-info --op-cert-file <redacted> $NET"
  { CARDANO_NODE_SOCKET_PATH=$S "$CCLI" query kes-period-info --op-cert-file "$OPCERT" $NET 2>&1 1>&3 3>&- | sed 's/^/[stderr] /'; } 3>&1
  echo "[exit ${PIPESTATUS[0]}]"
else
  echo "skipped (with_kes=$WITH_KES, opcert arg present=$([ -n "$OPCERT" ] && echo yes || echo no))"
fi
hdr "query leadership-schedule (read-model.js:594)"
echo "NOT CAPTURED: requires --vrf-signing-key-file. Help text only, to check flags still exist:"
run "\"$CCLI\" query leadership-schedule --help 2>&1 | head -40"
hdr "legacy vs era-prefixed command groups (deprecation check)"
run "\"$CCLI\" --help 2>&1 | head -40"
run "\"$CCLI\" query --help 2>&1 | head -60"

# ---- 5. Prometheus ----
# Default: each running node's metrics port - the listener (other than its
# --port) whose /metrics serves blockNum, the same test the app uses.
if [ ${#PORTS[@]} -eq 0 ]; then
  for RP in $(pgrep -x cardano-node 2>/dev/null); do
    NP=$(ps -p "$RP" -o args= 2>/dev/null | grep -oP -- '--port[= ]+\K[0-9]+')
    for C in $(ss -tlnp 2>/dev/null | grep "pid=$RP," | awk '{print $4}' | awk -F: '{print $NF}' | grep -v "^$NP$"); do
      if curl -sf --max-time 2 "http://127.0.0.1:$C/metrics" 2>/dev/null | grep -q blockNum; then PORTS+=("$C"); break; fi
    done
  done
fi
for P in "${PORTS[@]}"; do
  hdr "prometheus 127.0.0.1:$P/metrics (metrics-query.js:57 / relay-probe.js:207)"
  run "curl -sf --max-time 3 http://127.0.0.1:$P/metrics"
done
PROM_APP=$(ss -tlnp 2>/dev/null | grep "pid=$PID," | awk '{print $4}' | awk -F: '{print $NF}' | grep -v "^$NODE_PORT$" | head -1)
case " ${PORTS[*]} " in *" $PROM_APP "*) ;; *)
  if [ -n "$PROM_APP" ]; then hdr "prometheus on app-detected port $PROM_APP"; run "curl -sf --max-time 3 http://127.0.0.1:$PROM_APP/metrics"; fi ;;
esac

# ---- 6. Relay probe loop (relay-probe.js:96-104, identical) ----
hdr "relay probe loop (every cardano-node on host)"
for RP in $(pgrep -x cardano-node 2>/dev/null); do
  RA=$(ps -p "$RP" -o args= 2>/dev/null)
  NP=$(echo "$RA" | grep -oP -- '--port[= ]+\K[0-9]+')
  PP=$(ss -tlnp 2>/dev/null | grep "pid=$RP," | awk '{print $4}' | awk -F: '{print $NF}' | grep -v "^$NP$" | head -1)
  KES=$(echo "$RA" | grep -c -- '--shelley-kes-key')
  BIN=$(echo "$RA" | awk '{print $1}')
  echo "@@NODE@@"; echo "PID=$RP"; echo "ARGS=$RA" | redact; echo "NODE_PORT=$NP"; echo "PROM_PORT=$PP"; echo "KES=$KES"
  echo "VER=$("$BIN" --version 2>/dev/null | head -1)"
  ss -tlnp 2>/dev/null | grep "pid=$RP,"
done

# ---- 7. Peers (peers-query.js:62) - counts only, no peer IPs ----
hdr "ss -tnpi established (counts only)"
echo "sockets owned by PID $PID: $(ss -tnpi state established 2>/dev/null | grep -c "pid=$PID,")"
echo "rtt lines parseable: $(ss -tnpi state established 2>/dev/null | grep -A1 "pid=$PID," | grep -cE '\srtt:[0-9.]+/')"

# ---- 8. CNCLI databases (live.js:420, logs.js:189-192) - opened read-only ----
hdr "cncli.db chain table (live.js getChainPulse)"
if [ -f "$CNCLI_DB" ]; then
  run "sqlite3 -readonly '$CNCLI_DB' '.schema chain'"
  run "sqlite3 -readonly '$CNCLI_DB' 'SELECT slot_number FROM chain WHERE orphaned = 0 ORDER BY slot_number DESC LIMIT 5'"
else echo "no file at $CNCLI_DB"; fi
BLOCKLOG_DB=${CNODE_HOME:-}/guild-db/blocklog/blocklog.db
hdr "blocklog.db (logs.js Blocks minted)"
if [ -f "$BLOCKLOG_DB" ]; then
  run "sqlite3 -readonly '$BLOCKLOG_DB' '.schema blocklog'"
  run "nice -n 19 ionice -c3 sqlite3 -readonly -separator '\t' '$BLOCKLOG_DB' 'SELECT status, COUNT(*) FROM blocklog GROUP BY status ORDER BY COUNT(*) DESC;'"
  run "nice -n 19 ionice -c3 sqlite3 -readonly -separator '\t' '$BLOCKLOG_DB' 'SELECT epoch, slot_in_epoch, at, status, block, size, substr(hash,1,12) FROM blocklog ORDER BY slot DESC LIMIT 5;'"
else echo "no file at $BLOCKLOG_DB"; fi

# ---- 9. journalctl (logs.js QUERIES) ----
[ -z "$UNIT" ] && [ -n "${CNODE_HOME:-}" ] && UNIT="$(basename "${CNODE_HOME%/}").service"
[ -z "$UNIT" ] && { echo "CNODE_HOME empty and no --unit: journal sections use the app default cnode.service"; UNIT=cnode.service; }
STEM=${UNIT%.service}
hdr "systemd units matching $STEM*"
run "systemctl list-units --no-pager --all '$STEM*'"
hdr "journalctl -u $UNIT last 50 lines"
run "nice -n 19 ionice -c3 journalctl -u $UNIT --no-pager -n 50"
# Each Logs preset: match count over its window + last 3 matching lines.
preset() { # label unit hours pattern
  local n
  n=$(nice -n 19 ionice -c3 journalctl -u "$2" --no-pager --merge --since "$3 hours ago" -n 5000 2>/dev/null | grep -cE "$4")
  echo "-- preset '$1' unit=$2 window=${3}h pattern=/$4/ matches=$n"
  nice -n 19 ionice -c3 journalctl -u "$2" --no-pager --merge --since "$3 hours ago" -n 5000 2>/dev/null | grep -E "$4" | tail -3
}
hdr "Logs tab presets (logs.js:94-176)"
preset errwarn  "$UNIT" 24  '\((Warning|Error|Critical)'
preset kes      "$UNIT" 6   'KES info|OperationalCertificate|ExpiryLog'
preset restart  "$UNIT" 336 'Node version|cardano-node [0-9]|Started opening|Chain DB|Byron|Shelley|Conway|Started blockchain'
preset rollback "$UNIT" 24  'SwitchedToAFork|Rollback|RolledBack|switched to a fork'
preset leader   "$STEM-cncli-leaderlog.service" 168 'LEADER:|Leaderslots:|Leaderlog calculation'
preset validate "$STEM-cncli-validate.service"  168 'adopted|confirmed|missed|ADOPTED|CONFIRMED|MISSED|GHOSTED|STOLEN'
echo "-- 'recent' preset: last 10 lines after the app's grep -v filter"
nice -n 19 ionice -c3 journalctl -u "$UNIT" --no-pager --merge --since "6 hours ago" -n 5000 2>/dev/null \
  | grep -vE 'Net\.Mux\.Local|StateQueryServer|LocalHandshake|Forge\.Loop\.StartLeadershipCheck|Forge\.Loop\.NodeNotLeader|Forge\.StateInfo\.StateInfo|Mempool\.AddedTx' | tail -10
hdr "journal namespaces seen in last 10 min (message-format sample)"
nice -n 19 ionice -c3 journalctl -u "$UNIT" --no-pager --since "10 min ago" -o cat 2>/dev/null \
  | grep -oE '\[[A-Za-z0-9._-]+:[A-Za-z]+:[A-Za-z0-9]+\]|[A-Z][A-Za-z]+(\.[A-Za-z]+){1,4}' | sort | uniq -c | sort -rn | head -30

hdr "end of capture"
