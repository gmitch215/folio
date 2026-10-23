#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

set_name=${1:?usage: php-concurrent.sh SET [label]}
label=${2:-folio-phpconcurrent-$(date +%Y%m%d)}
node_bin=${FOLIO_RIG_NODE:-node}
sweep=${FOLIO_RIG_SWEEP:?set FOLIO_RIG_SWEEP to the rig sweep script}
mask=${FOLIO_RIG_MASK:-2-11}
pairs_cpu=${FOLIO_PAIRS_CPU:-20}
pairs_drupal=${FOLIO_PAIRS_DRUPAL:-10}
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
	printf '%s\n' "$code" > "$out/exit-code"
	touch "$out/finished"
	exit "$code"
}
trap finish EXIT

export FOLIO_CONSUMER=$stage/consumer
export FOLIO_WORKER_BUNDLE=$stage/php-context-worker.mjs
export FOLIO_PLAN=$stage/build/php-prepared-admit.bin
export FOLIO_MACHINE="${FOLIO_RIG_MACHINE:-Ryzen 9 9900X}, cpus $mask, nice 19"
export FOLIO_AFFINITY=$mask

run() {
	nice -n 19 taskset -c "$mask" "$node_bin" --max-old-space-size=1024 "$@"
}
probe=scripts/probe/php-concurrent.ts

mkdir -p "$out"
mkdir /tmp/folio-timing.lock
held=1
bash "$sweep" start "$label"
{
	echo "governor: $(cat /sys/devices/system/cpu/cpu2/cpufreq/scaling_governor 2> /dev/null || echo unknown)"
	echo "node: $("$node_bin" --version)"
	uptime
	free -m
	df -h /
} > "$out/machine.txt"

uptime > "$out/load-before-cpu.txt"
run "$probe" cpu "$out/cpu.jsonl" "$pairs_cpu" 1,2,4,8
for what in cpu drupal; do
	for mode in native folio; do
		for count in 1 2 4 8; do
			run "$probe" memory "$out/memory-$what-$mode-$count.jsonl" "$what" "$mode" "$count"
		done
	done
done
df -h / | tail -1 >> "$out/machine.txt"
uptime > "$out/load-before-drupal.txt"
run "$probe" drupal "$out/drupal.jsonl" "$pairs_drupal" 1,2,4,8
free -m >> "$out/machine.txt"
df -h / | tail -1 >> "$out/machine.txt"
