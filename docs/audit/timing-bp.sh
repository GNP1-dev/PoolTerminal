#!/usr/bin/env bash
# PoolTerminal - read-only timing of every cardano-cli query the app runs.
# 2026-09-24, for fix-plan item 4 (A2 per-command timeouts) and finding A10.
#
# READ-ONLY. Pipe it over SSH so nothing is written on the target:
#   ssh <user>@<bp-host> 'bash -s' < docs/audit/timing-bp.sh > docs/audit/timing-bp.txt 2>&1
# For a non-stock layout pass the env: 'bash -s -- --env /opt/cardano/<bp-instance>/scripts/env'
#
# Times query tip, query tx-mempool info, query kes-period-info and
# query stake-snapshot (this pool) 3 times each, with the same flags the app
# uses, and prints wall-clock durations. Query output is discarded; only exit
# codes and durations are printed. Every cli call runs under nice -n 19
# ionice -c3 with a 2 s pause between runs. `query leadership-schedule` is not
# timed: it needs the VRF signing key (its timeout is the 300 s floor).
# The op cert path for kes-period-info is read from the running node's own
# arguments at run time and never printed.
#
# Options (all optional):
#   --env PATH     Guild env file (default: Guild stock /opt/cardano/cnode/scripts/env)
#   --pool-id HEX  pool id when the env has no POOL_ID (baseline runs only)
#   --runs N       runs per query (default 3)

ENV_FILE=/opt/cardano/cnode/scripts/env
POOL_ID_ARG=
RUNS=3
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE=$2; shift 2 ;;
    --pool-id) POOL_ID_ARG=$2; shift 2 ;;
    --runs) RUNS=$2; shift 2 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done
NICE='nice -n 19 ionice -c3'

cd "$(dirname "$ENV_FILE")" || { echo "cannot cd to the env directory"; exit 1; }
# shellcheck disable=SC1090
source "./$(basename "$ENV_FILE")" offline >/dev/null 2>&1
echo "env_rc=$? host=$(hostname) date=$(date -u +%FT%TZ)"
: "${CARDANO_NODE_SOCKET_PATH:=${CNODE_HOME:-}/sockets/node.socket}"
: "${NETWORK_IDENTIFIER:=--mainnet}"
[ -z "${POOL_ID:-}" ] && POOL_ID=$POOL_ID_ARG
S=$CARDANO_NODE_SOCKET_PATH
echo "cli=$("$CCLI" --version | head -1)"

PID=$(fuser "$S" 2>/dev/null | tr -d ' \n')
[ -z "$PID" ] && PID=$(ps -eo pid,args | awk -v s="$S" '/[c]ardano-node/ && index($0, "--socket-path " s) { print $1; exit }')
echo "node=$("$(readlink -f "/proc/$PID/exe")" --version 2>/dev/null | head -1)"
OPCERT=$(ps -p "$PID" -o args= 2>/dev/null | grep -oP -- '--shelley-operational-certificate\s+\K\S+')

# time_q LABEL ARGS... : run the cli RUNS times, print each duration in ms.
time_q() {
  local label=$1; shift
  local i t0 t1 rc all=""
  for i in $(seq 1 "$RUNS"); do
    t0=$(date +%s%N)
    CARDANO_NODE_SOCKET_PATH=$S $NICE "$CCLI" "$@" $NETWORK_IDENTIFIER >/dev/null 2>&1
    rc=$?
    t1=$(date +%s%N)
    all="$all $(( (t1 - t0) / 1000000 ))ms(rc=$rc)"
    sleep 2
  done
  printf '%-20s%s\n' "$label" "$all"
}

echo "---- durations, $RUNS runs each ----"
time_q "query tip" query tip
time_q "tx-mempool info" query tx-mempool info
if [ -n "$OPCERT" ]; then time_q "kes-period-info" query kes-period-info --op-cert-file "$OPCERT"
else echo "kes-period-info     skipped (no op cert argument on this node)"; fi
if [ -n "$POOL_ID" ]; then time_q "stake-snapshot" query stake-snapshot --stake-pool-id "$POOL_ID"
else echo "stake-snapshot      skipped (no POOL_ID)"; fi
echo "---- end ----"
