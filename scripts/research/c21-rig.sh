#!/usr/bin/env bash
# bulk drivers: counters pass, then timed sessions of 5 rounds after 2 warmups, one pool at a time
# usage: c21-rig.sh [SESSIONS] [ROUNDS] OUTPUT_DIRECTORY
# needs FOLIO_RIG_NODE, FOLIO_RESEARCH_REVISION, clang with wasm32 and the corpus sources under
# build/research/corpus (run `node scripts/research/corpus.ts build` first). C21_OUT, when set,
# is the module directory relative to the repo root (default build/research/c21)
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir /tmp/folio-timing.lock
trap 'rmdir /tmp/folio-timing.lock' EXIT
sessions=${1:-3}
rounds=${2:-5}
out=${3:?usage: c21-rig.sh [SESSIONS] [ROUNDS] OUTPUT_DIRECTORY}
mkdir -p "$out"
node_bin=${FOLIO_RIG_NODE:?set FOLIO_RIG_NODE}
export FOLIO_RESEARCH_REVISION=${FOLIO_RESEARCH_REVISION:?set FOLIO_RESEARCH_REVISION}
width=${FOLIO_WIDTH:-8}
run() {
	nice -n 19 taskset -c 4-11 timeout "$1" "$node_bin" --max-old-space-size=2048 "${@:2}"
}
{
	free -m
	uptime
	cat /sys/devices/system/cpu/cpu4/cpufreq/scaling_governor
} > "$out/before.log"
run 600 scripts/research/c21-kernels.ts > "$out/build.log" 2>&1
(cd "${C21_OUT:-build/research/c21}" && sha256sum -- *.wasm) > "$out/modules.sha256"
ids=$("$node_bin" -e "import('./scripts/research/c21-kernels.ts').then((m) => console.log(m.specs.map((s) => s.id).join(' ')))")
for id in $ids; do
	run 1800 scripts/research/c21-bench.ts counters "$id" "$out/counters-$id.jsonl" 2 "$width" > "$out/counters-$id.log" 2>&1 || true
done
for session in $(seq 1 "$sessions"); do
	for id in $ids; do
		run 3600 scripts/research/c21-bench.ts timed "$id" "$out/timed-$id-$session.jsonl" "$rounds" "$width" > "$out/timed-$id-$session.log" 2>&1 || true
	done
done
JSON=1 "$node_bin" scripts/research/c21-summary.mjs "$out"/timed-*.jsonl > "$out/summary.json"
"$node_bin" scripts/research/c21-summary.mjs "$out"/timed-*.jsonl > "$out/summary.txt"
printf '%s\n' complete > "$out/finished"
free -m > "$out/after.log"
