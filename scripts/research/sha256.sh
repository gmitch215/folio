#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir /tmp/folio-timing.lock
trap 'rmdir /tmp/folio-timing.lock' EXIT
out=${3:-build/research/sha256-runs}
mkdir -p "$out"
node_bin=${FOLIO_RIG_NODE:?set FOLIO_RIG_NODE}
export FOLIO_RESEARCH_REVISION=${FOLIO_RESEARCH_REVISION:?set FOLIO_RESEARCH_REVISION}
sessions=${1:-3}
rounds=${2:-9}
{
	free -m
	uptime
	cat /sys/devices/system/cpu/cpu4/cpufreq/scaling_governor
} > "$out/before.log"
run() {
	nice -n 19 taskset -c 4-11 timeout 1200 "$node_bin" --max-old-space-size=2048 scripts/research/sha256-bench.ts "$@"
}
for session in $(seq 1 "$sessions"); do
	run "$out/large-$session.jsonl" "$rounds" 32 1024 helper > "$out/large-$session.log" 2>&1
	run "$out/small-$session.jsonl" "$rounds" 128 256 helper > "$out/small-$session.log" 2>&1
	run "$out/all-large-$session.jsonl" "$rounds" 32 1024 all > "$out/all-large-$session.log" 2>&1
	run "$out/all-small-$session.jsonl" "$rounds" 128 256 all > "$out/all-small-$session.log" 2>&1
done
printf '%s\n' complete > "$out/finished"
