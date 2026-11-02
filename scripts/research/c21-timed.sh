#!/bin/sh
# directional timings, one module and one pool at a time
# usage: c21-timed.sh OUTPUT_DIRECTORY [ROUNDS] [WIDTH]
out=${1:?output directory}
rounds=${2:-5}
width=${3:-8}
mkdir -p "$out"
export FOLIO_RESEARCH_REVISION=${FOLIO_RESEARCH_REVISION:-c21}
ids=$(node -e "import('./scripts/research/c21-kernels.ts').then((m) => console.log(m.specs.map((s) => s.id).join(' ')))")
for id in $ids; do
	file="$out/timed-$id.jsonl"
	[ -e "$file" ] && continue
	echo "== $id load $(uptime | sed 's/.*averages: //')"
	timeout 900 nice -n 10 node scripts/research/c21-bench.ts timed "$id" "$file" "$rounds" "$width" || echo "FAILED $id"
done
echo finished
