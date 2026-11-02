#!/bin/sh
# counters first: automatic and forced, two runs each, serial equality asserted in every run
# usage: c21-counters.sh OUTPUT_DIRECTORY [WIDTH]
set -e
out=${1:?output directory}
width=${2:-8}
mkdir -p "$out"
export FOLIO_RESEARCH_REVISION=${FOLIO_RESEARCH_REVISION:-c21}
ids=$(node -e "import('./scripts/research/c21-kernels.ts').then((m) => console.log(m.specs.map((s) => s.id).join(' ')))")
for id in $ids; do
	file="$out/counters-$id.jsonl"
	[ -e "$file" ] && continue
	echo "== $id load $(uptime | sed 's/.*averages: //')"
	timeout 600 node scripts/research/c21-bench.ts counters "$id" "$file" 2 "$width" || echo "FAILED $id"
done
