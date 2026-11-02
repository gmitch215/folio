#!/usr/bin/env bash
# timed sessions of the native parallel baseline, a fresh process per driver and session
# usage: native-bulk-arms.sh [SESSIONS] [ROUNDS] OUTPUT_DIRECTORY
# C21_IDS narrows the drivers; FOLIO_WIDTH sets the thread count (default 8); CC and NODE as in native-bulk.sh
# needs the built c21 modules, which the record export runs serially to make decoder inputs
set -euo pipefail
cd "$(dirname "$0")/../.."
sessions=${1:-3}
rounds=${2:-5}
out=${3:?usage: native-bulk-arms.sh [SESSIONS] [ROUNDS] OUTPUT_DIRECTORY}
node_bin=${NODE:-node}
width=${FOLIO_WIDTH:-8}
build=${NB_OUT:-build/research/native-bulk}
ids=${C21_IDS:-$("$node_bin" scripts/research/native-bulk-export.ts list | tr '\n' ' ')}
mkdir -p "$out"
for id in $ids; do
	[ -x "$build/$id/bin" ] || bash scripts/research/native-bulk.sh build "$id" > "$out/build-$id.log" 2>&1 || echo "FAILED $id build" >> "$out/failed.log"
done
mkdir /tmp/folio-timing.lock
trap 'rmdir /tmp/folio-timing.lock' EXIT
for session in $(seq 1 "$sessions"); do
	for id in $ids; do
		file=$out/$id-$session.jsonl
		[ -e "$file" ] && continue
		[ -x "$build/$id/bin" ] || continue
		status=0
		nice -n 19 taskset -c 4-11 timeout 300 "$build/$id/bin" "$id" "$build/$id/records.nbk" "$width" "$rounds" 2 > "$file" 2> "$file.log" || status=$?
		[ "$status" -eq 0 ] || [ "$status" -eq 3 ] || echo "FAILED $id $session" >> "$out/failed.log"
	done
done
"$node_bin" scripts/research/native-bulk-table.mjs "$out" > "$out/summary.md"
printf '%s\n' complete > "$out/finished"
