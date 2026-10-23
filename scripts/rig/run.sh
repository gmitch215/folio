#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

kind=${1:?usage: run.sh sharing|cpu|large|scaling|control|affinity|all [label]}
label=${2:-folio-$kind-$(date +%Y%m%d)}
node_bin=${FOLIO_RIG_NODE:-node}
sweep=${FOLIO_RIG_SWEEP:?set FOLIO_RIG_SWEEP to the rig sweep script}
held=0

case "$kind" in
	sharing | cpu | large | all | scaling | control | affinity) ;;
	*)
		echo "unknown probe: $kind" >&2
		exit 2
		;;
esac

finish() {
	code=$?
	trap - EXIT
	if [ "$held" = 1 ]; then
		bash "$sweep" end "$label" || true
		rmdir /tmp/folio-timing.lock || true
	fi
	printf '%s\n' "$code" > results/exit-code
	touch results/finished
	exit "$code"
}
trap finish EXIT

# nice 19 and a fixed CPU mask are part of the method; run reads mask then node flags then script
run() {
	local mask=$1
	shift
	nice -n 19 taskset -c "$mask" "$node_bin" --max-old-space-size=128 "$@"
}

sharing() {
	for round in 0 1 2; do
		for mode in shared copied; do
			run 4,6,8,10 --expose-gc scripts/probe/sharing-probe.mjs "$mode" 64 > "results/sharing-$mode-$round.jsonl"
		done
	done
	run 4,6,8,10 --expose-gc scripts/probe/sharing-probe.mjs shared 256 > results/sharing-large.jsonl
}

mkdir -p results
mkdir /tmp/folio-timing.lock
held=1
bash "$sweep" start "$label"

case "$kind" in
	sharing) sharing ;;
	cpu) run 4,6,8,10 --experimental-strip-types scripts/probe/cpu-probe.ts > results/cpu.jsonl ;;
	large) run 4,6,8,10 --experimental-strip-types scripts/probe/large-probe.ts > results/large.jsonl ;;
	all)
		sharing
		run 4,6,8,10 --experimental-strip-types scripts/probe/cpu-probe.ts > results/cpu.jsonl
		;;
	scaling) run 4-11 --experimental-strip-types scripts/probe/scaling-probe.ts > results/scaling.jsonl ;;
	control) run 4-11 scripts/probe/control-probe.mjs > results/control.jsonl ;;
	affinity) run 4-11 scripts/probe/control-affinity.mjs > results/affinity.jsonl ;;
esac

free -h
df -h /
du -sh .
