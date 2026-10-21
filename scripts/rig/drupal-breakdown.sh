#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

set_name=${1:?usage: drupal-breakdown.sh SET [label]}
label=${2:-folio-drupalbreakdown-$(date +%Y%m%d)}
node_bin=${FOLIO_RIG_NODE:-$HOME/.nvm/versions/node/v26.10.0/bin/node}
sweep=${FOLIO_RIG_SWEEP:-$HOME/gmux-rig/bin/sweep.sh}
mask=${FOLIO_RIG_MASK:-2-11}
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
	printf '%s\n' "$code" > "$out/breakdown-exit-code"
	touch "$out/breakdown-finished"
	exit "$code"
}
trap finish EXIT

export FOLIO_CONSUMER=$stage/consumer
export FOLIO_WORKER_BUNDLE=$stage/php-context-worker.mjs
export FOLIO_PLAN=$stage/build/php-prepared-admit.bin
export FOLIO_MACHINE="paisley-park Ryzen 9 9900X, cpus $mask, nice 19"

mkdir -p "$out"
mkdir /tmp/paisley-timing.lock
held=1
bash "$sweep" start "$label"
uptime > "$out/load-before-breakdown.txt"
nice -n 19 taskset -c "$mask" "$node_bin" scripts/probe/drupal-breakdown.ts "$out/breakdown.jsonl" "${FOLIO_PROCESSES:-10}" "${FOLIO_INSTANCES:-5}"
free -m >> "$out/load-before-breakdown.txt"
df -h / | tail -1 >> "$out/load-before-breakdown.txt"
