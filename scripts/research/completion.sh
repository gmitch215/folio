#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir /tmp/folio-timing.lock
trap 'rmdir /tmp/folio-timing.lock' EXIT
mkdir -p build/research/completion
node_bin=${FOLIO_RIG_NODE:?set FOLIO_RIG_NODE}
export FOLIO_RESEARCH_REVISION=160f268
run() {
	nice -n 19 taskset -c 4-11 timeout "$1" "$node_bin" --max-old-space-size=128 "${@:2}"
}
free -m > build/research/completion/before.log
df -h / >> build/research/completion/before.log
run 600 scripts/research/corpus-serial.ts build/research/completion/serial 9 > build/research/completion/serial.log 2>&1
FOLIO_CORPUS_RESET=checkpoint run 1200 scripts/research/corpus-mechanisms.ts build/research/completion/checkpoint 7 4 > build/research/completion/checkpoint.log 2>&1
run 1500 scripts/research/admission-diagnostic.ts build/research/completion/admission 60 > build/research/completion/admission.log 2>&1
printf '%s\n' complete > build/research/completion/finished
free -m > build/research/completion/after.log
df -h / >> build/research/completion/after.log
du -sh . >> build/research/completion/after.log
