#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

set_name=${1:?usage: php-intra.sh SET [label]}
label=${2:-folio-phpintra-$(date +%Y%m%d)}
node_bin=${FOLIO_RIG_NODE:-$HOME/.nvm/versions/node/v26.10.0/bin/node}
sweep=${FOLIO_RIG_SWEEP:-$HOME/gmux-rig/bin/sweep.sh}
mask=${FOLIO_RIG_MASK:-2-11}
pairs=${FOLIO_PAIRS:-20}
widths=${FOLIO_WIDTHS:-1,2,4,8}
rounds=${FOLIO_COMPILE_ROUNDS:-20}
steps=${FOLIO_STEPS:-compile intra intra-drupal snapshot}
plain=${FOLIO_PLAIN_WORKLOADS:-hash-batch,hash-small,preg-docs,serialize-roundtrip,compress,mixed}
out=results/$set_name
stage=${FOLIO_STAGE:-$PWD/stage}
held=0

finish() {
	code=$?
	trap - EXIT
	if [ "$held" = 1 ]; then
		bash "$sweep" end "$label" || true
		rmdir /tmp/paisley-timing.lock || true
	fi
	printf '%s\n' "$code" > "$out/intra-exit-code"
	touch "$out/intra-finished"
	exit "$code"
}
trap finish EXIT

export FOLIO_CONSUMER=$stage/consumer
export FOLIO_WORKER_BUNDLE=$stage/php-context-worker.mjs
export FOLIO_MACHINE="paisley-park Ryzen 9 9900X, cpus $mask, nice 19"
export FOLIO_AFFINITY=$mask

run() {
	nice -n 19 taskset -c "$mask" "$node_bin" --max-old-space-size=1024 "$@"
}

mkdir -p "$out"
mkdir /tmp/paisley-timing.lock
held=1
bash "$sweep" start "$label"
{
	echo "governor: $(cat /sys/devices/system/cpu/cpu2/cpufreq/scaling_governor 2> /dev/null || echo unknown)"
	echo "node: $("$node_bin" --version)"
	echo "steps: $steps"
	uptime
	free -m
	df -h / | tail -1
} > "$out/intra-machine.txt"

for step in $steps; do
	uptime > "$out/load-before-$step.txt"
	case $step in
		compile) run scripts/probe/php-compile.ts "$out/compile-rig.jsonl" "$rounds" 5 ;;
		intra) run scripts/probe/php-intra.ts "$out/intra-rig.jsonl" "$pairs" "$widths" "$plain" ;;
		intra-drupal)
			run scripts/probe/php-intra.ts "$out/intra-drupal-rig.jsonl" "$pairs" "$widths" drupal-render-arrays
			;;
		snapshot) run scripts/probe/php-snapshot.ts "$out/snapshot-rig.jsonl" 20 ;;
	esac
done
free -m >> "$out/intra-machine.txt"
df -h / | tail -1 >> "$out/intra-machine.txt"
