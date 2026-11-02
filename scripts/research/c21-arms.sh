#!/usr/bin/env bash
# timed sessions with a fresh node process per arm, so no arm runs on code another arm tiered up
# usage: c21-arms.sh [SESSIONS] [ROUNDS] OUTPUT_DIRECTORY
# needs FOLIO_RIG_NODE, FOLIO_RESEARCH_REVISION and the built drivers (see c21-rig.sh)
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir /tmp/folio-timing.lock
trap 'rmdir /tmp/folio-timing.lock' EXIT
sessions=${1:-3}
rounds=${2:-5}
out=${3:?usage: c21-arms.sh [SESSIONS] [ROUNDS] OUTPUT_DIRECTORY}
mkdir -p "$out"
node_bin=${FOLIO_RIG_NODE:?set FOLIO_RIG_NODE}
export FOLIO_RESEARCH_REVISION=${FOLIO_RESEARCH_REVISION:?set FOLIO_RESEARCH_REVISION}
width=${FOLIO_WIDTH:-8}
ids=$("$node_bin" -e "import('./scripts/research/c21-kernels.ts').then((m) => console.log(m.specs.map((s) => s.id).join(' ')))")
for session in $(seq 1 "$sessions"); do
	for id in $ids; do
		for arm in automatic forced explicit; do
			file=$out/$arm-$id-$session.jsonl
			[ -e "$file" ] && continue
			C21_ARMS=$arm nice -n 19 taskset -c 4-11 timeout 900 "$node_bin" --max-old-space-size=2048 \
				scripts/research/c21-bench.ts timed "$id" "$file" "$rounds" "$width" > "$file.log" 2>&1 || echo "FAILED $arm $id $session" >> "$out/failed.log"
		done
	done
done
node scripts/research/c21-arms-table.mjs "$out" > "$out/summary.md"
printf '%s\n' complete > "$out/finished"
