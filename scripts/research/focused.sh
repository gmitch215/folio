#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir /tmp/folio-timing.lock
trap 'rmdir /tmp/folio-timing.lock' EXIT
out=build/research/focused
mkdir -p "$out"
node_bin=${FOLIO_RIG_NODE:?set FOLIO_RIG_NODE}
export FOLIO_RESEARCH_REVISION=${FOLIO_RESEARCH_REVISION:?set FOLIO_RESEARCH_REVISION}
sessions=${1:-5}
pairs=${2:-9}
{
	free -m
	df -h /
	uptime
	cat /sys/devices/system/cpu/cpu4/cpufreq/scaling_governor
} > "$out/before.log"
for session in $(seq 1 "$sessions"); do
	FOLIO_FOCUSED_SESSION=$session nice -n 19 taskset -c 4-11 timeout 1500 \
		"$node_bin" --max-old-space-size=128 scripts/research/focused.ts \
		"$out/session-$session" "$pairs" > "$out/session-$session.log" 2>&1
done
{
	free -m
	df -h /
	du -sh .
} > "$out/after.log"
printf '%s\n' complete > "$out/finished"
