#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir /tmp/folio-timing.lock
trap 'rmdir /tmp/folio-timing.lock' EXIT
out=${3:-build/research/grain-runs}
mkdir -p "$out"
node_bin=${FOLIO_RIG_NODE:?set FOLIO_RIG_NODE}
export FOLIO_RESEARCH_REVISION=${FOLIO_RESEARCH_REVISION:?set FOLIO_RESEARCH_REVISION}
sessions=${1:-3}
rounds=${2:-25}
{
	free -m
	uptime
	cat /sys/devices/system/cpu/cpu4/cpufreq/scaling_governor
} > "$out/before.log"
for session in $(seq 1 "$sessions"); do
	for variant in small stock; do
		nice -n 19 taskset -c 4-11 timeout 900 "$node_bin" scripts/research/grain-bench.ts \
			"$out/$variant-$session.jsonl" "$rounds" 3 "$variant" > "$out/$variant-$session.log" 2>&1
	done
done
printf '%s\n' complete > "$out/finished"
