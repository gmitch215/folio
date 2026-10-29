#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir /tmp/folio-timing.lock
trap 'rmdir /tmp/folio-timing.lock' EXIT
out=build/research/matched
mkdir -p "$out"
node_bin=${FOLIO_RIG_NODE:?set FOLIO_RIG_NODE}
export FOLIO_RESEARCH_REVISION=${FOLIO_RESEARCH_REVISION:?set FOLIO_RESEARCH_REVISION}
run() {
	nice -n 19 taskset -c 4-11 timeout "$1" "$node_bin" --max-old-space-size=128 "${@:2}"
}
free -m > "$out/before.log"
df -h / >> "$out/before.log"
for mode in whole pages checkpoint; do
	FOLIO_CORPUS_RESET=$mode run 1500 scripts/research/corpus-mechanisms.ts "$out/reset-$mode" 7 4 > "$out/reset-$mode.log" 2>&1
done
run 600 scripts/research/corpus-serial.ts "$out/default-entry" 9 > "$out/default-entry.log" 2>&1
run 1200 scripts/research/boot-eligibility.ts "$out/initializer" 15 > "$out/initializer.log" 2>&1
run 900 scripts/research/graded.ts "$out/graded" 9 > "$out/graded.log" 2>&1
FOLIO_CORPUS_ADMISSION=0 run 900 scripts/research/corpus-serial.ts "$out/forced-m6502" 3 m6502 > "$out/forced-m6502.log" 2>&1 || true
printf '%s\n' complete > "$out/finished"
free -m > "$out/after.log"
df -h / >> "$out/after.log"
du -sh . >> "$out/after.log"
