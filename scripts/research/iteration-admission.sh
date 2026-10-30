#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir /tmp/folio-timing.lock
trap 'rmdir /tmp/folio-timing.lock' EXIT
out=${3:-build/research/admission-runs}
mkdir -p "$out"
node_bin=${FOLIO_RIG_NODE:?set FOLIO_RIG_NODE}
export FOLIO_RESEARCH_REVISION=${FOLIO_RESEARCH_REVISION:?set FOLIO_RESEARCH_REVISION}
sessions=${1:-3}
rounds=${2:-5}
{
	free -m
	uptime
	cat /sys/devices/system/cpu/cpu4/cpufreq/scaling_governor
} > "$out/before.log"
for session in $(seq 1 "$sessions"); do
	nice -n 19 taskset -c 4-11 timeout 3600 "$node_bin" --max-old-space-size=2048 scripts/research/iteration-admission.ts run "$out/sweep-$session.jsonl" "$rounds" "${FOLIO_WIDTH:-8}" > "$out/sweep-$session.log" 2>&1
done
"$node_bin" scripts/research/iteration-admission.ts summary "$out"/sweep-*.jsonl --json "$out/summary.json" > "$out/summary.txt"
printf '%s\n' complete > "$out/finished"
