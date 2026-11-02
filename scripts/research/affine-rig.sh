#!/usr/bin/env bash
# affine, state, sweep and shared-input timings on the Linux rig, one stage at a time under the timing lock
# usage: affine-rig.sh OUTPUT_DIRECTORY
# needs FOLIO_RIG_NODE, FOLIO_RESEARCH_REVISION and the wasm built on another machine (affine-build.ts,
# affine-state-build.ts, sweeps-build.ts, c21-kernels.ts); the rig has no wasm-ld
set -uo pipefail
cd "$(dirname "$0")/../.."
out=$(mkdir -p "${1:?usage: affine-rig.sh OUTPUT_DIRECTORY}" && cd "$1" && pwd)
node_bin=${FOLIO_RIG_NODE:?set FOLIO_RIG_NODE}
export FOLIO_RESEARCH_REVISION=${FOLIO_RESEARCH_REVISION:?set FOLIO_RESEARCH_REVISION}
run() {
	nice -n 19 taskset -c 4-11 timeout "$1" "$node_bin" --max-old-space-size=2048 "${@:2}"
}
stage() {
	name=$1
	shift
	[ "$name" = shared ] || until mkdir /tmp/folio-timing.lock 2> /dev/null; do sleep 30; done
	{
		date -u +%FT%TZ
		uptime
		free -m
		cat /sys/devices/system/cpu/cpu4/cpufreq/scaling_governor
	} > "$out/$name.before.log"
	"$@"
	rc=$?
	{
		date -u +%FT%TZ
		uptime
		echo "rc=$rc"
	} > "$out/$name.after.log"
	[ "$name" = shared ] || rmdir /tmp/folio-timing.lock
	echo "$name rc=$rc" >> "$out/progress.log"
}
affine() {
	for s in 1 2 3; do run 3600 scripts/research/affine-bench.ts "$out/affine.jsonl" "$s" 5 1,8,64 > "$out/affine-session-$s.log" 2>&1; done
}
state() {
	for s in 1 2 3; do run 3600 scripts/research/affine-state-bench.ts "$out/state.jsonl" "$s" 5 1,8,64 all > "$out/state-session-$s.log" 2>&1; done
}
sweepcount() {
	run 3600 scripts/research/sweeps-bench.ts count "$out/sweeps-count.jsonl" 1 5 65536,1048576,67108864 > "$out/sweeps-count.log" 2>&1
	run 3600 scripts/research/sweeps-bench.ts states "$out/sweeps-states.jsonl" > "$out/sweeps-states.log" 2>&1
}
sweepwall() {
	for s in 1 2 3; do run 7200 scripts/research/sweeps-bench.ts wall "$out/sweeps-wall-s$s.jsonl" "$s" 5 65536,1048576,67108864 > "$out/sweeps-wall-s$s.log" 2>&1; done
}
stage affine affine
stage state state
stage sweepcount sweepcount
stage sweepwall sweepwall
stage shared bash scripts/research/c21-shared.sh 3 5 "$out/shared"
printf '%s\n' complete > "$out/finished"
