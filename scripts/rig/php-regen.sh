#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

set_name=${1:?usage: php-regen.sh SET NAME [label]}
name=${2:?usage: php-regen.sh SET NAME [label]}
label=${3:-folio-phpregen-$(date +%Y%m%d)}
node_bin=${FOLIO_RIG_NODE:-node}
sweep=${FOLIO_RIG_SWEEP:?set FOLIO_RIG_SWEEP to the rig sweep script}
mask=${FOLIO_RIG_MASK:-2-11}
pairs=${FOLIO_PAIRS:-20}
widths=${FOLIO_WIDTHS:-2,4,8}
nodes=${FOLIO_NODES:-30}
out=results/$set_name
stage=${FOLIO_STAGE:-$PWD/stage}
held=0

finish() {
	code=$?
	trap - EXIT
	if [ "$held" = 1 ]; then
		bash "$sweep" end "$label" || true
		rmdir /tmp/folio-timing.lock || true
	fi
	printf '%s\n' "$code" > "$out/$name-exit-code"
	touch "$out/$name-finished"
	exit "$code"
}
trap finish EXIT

export FOLIO_CONSUMER=$stage/consumer
export FOLIO_WORKER_BUNDLE=$stage/php-context-worker.mjs
export FOLIO_MACHINE="${FOLIO_RIG_MACHINE:-Ryzen 9 9900X}, cpus $mask, nice 19"
export FOLIO_AFFINITY=$mask

run() {
	nice -n 19 taskset -c "$mask" "$node_bin" --max-old-space-size=1024 "$@"
}

mkdir -p "$out"
for _ in $(seq 60); do
	if mkdir /tmp/folio-timing.lock 2> /dev/null; then
		held=1
		break
	fi
	sleep 10
done
[ "$held" = 1 ] || {
	echo 'timing lock busy for 10 minutes' >&2
	exit 75
}
bash "$sweep" start "$label"
{
	echo "governor: $(cat /sys/devices/system/cpu/cpu2/cpufreq/scaling_governor 2> /dev/null || echo unknown)"
	echo "node: $("$node_bin" --version)"
	echo "mask: $mask widths: $widths pairs: $pairs nodes: $nodes"
	uptime
	free -m
	df -h / | tail -1
} > "$out/$name-machine.txt"

run scripts/probe/php-regen.ts "$out/$name.jsonl" "$pairs" "$widths" "$nodes"
{
	uptime
	free -m
	df -h / | tail -1
} >> "$out/$name-machine.txt"
