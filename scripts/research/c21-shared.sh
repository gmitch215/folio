#!/usr/bin/env bash
# explicit arm as copy, shared, skip and in-place variants, each cell in a fresh process under the timing lock
# usage: c21-shared.sh [SESSIONS] [ROUNDS] OUTPUT_DIRECTORY
# needs FOLIO_RIG_NODE, FOLIO_RESEARCH_REVISION and the built drivers (see c21-rig.sh)
# C21_PROGRAMS, C21_SIZES and C21_VARIANTS narrow the matrix; a missing taskset or lock is not skipped
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir /tmp/folio-timing.lock
trap 'rmdir /tmp/folio-timing.lock' EXIT
sessions=${1:-3}
rounds=${2:-5}
out=${3:?usage: c21-shared.sh [SESSIONS] [ROUNDS] OUTPUT_DIRECTORY}
mkdir -p "$out"
node_bin=${FOLIO_RIG_NODE:?set FOLIO_RIG_NODE}
export FOLIO_RESEARCH_REVISION=${FOLIO_RESEARCH_REVISION:?set FOLIO_RESEARCH_REVISION}
width=${FOLIO_WIDTH:-8}
programs=${C21_PROGRAMS:-xxhash32 xxhash64 xxhash3 miniz-adler32 lz4-decompress}
sizes=${C21_SIZES:-64 512 4096}
variants=${C21_VARIANTS:-copy shared skip inplace}
pin=()
command -v taskset > /dev/null && pin=(taskset -c 4-11)
for session in $(seq 1 "$sessions"); do
	for id in $programs; do
		for n in $sizes; do
			for variant in $variants; do
				file=$out/$variant-$id-n$n-$session.jsonl
				[ -e "$file" ] && continue
				shared=0
				[ "$variant" = copy ] || shared=1
				overwrite=0
				arm=explicit
				[ "$variant" = inplace ] && arm=inplace
				[ "$variant" = skip ] && overwrite=1
				C21_ARMS=$arm C21_N=$n C21_SHARED=$shared C21_OVERWRITE=$overwrite nice -n 19 ${pin[@]+"${pin[@]}"} timeout 900 "$node_bin" --max-old-space-size=2048 \
					scripts/research/c21-bench.ts timed "$id" "$file" "$rounds" "$width" > "$file.log" 2>&1 || echo "FAILED $variant $id $n $session" >> "$out/failed.log"
			done
		done
	done
done
"$node_bin" scripts/research/c21-shared-table.mjs "$out" > "$out/summary.md"
printf '%s\n' complete > "$out/finished"
