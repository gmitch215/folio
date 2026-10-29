#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir /tmp/folio-timing.lock
trap 'rmdir /tmp/folio-timing.lock' EXIT
node_bin=${FOLIO_RIG_NODE:?set FOLIO_RIG_NODE}
export FOLIO_RESEARCH_REVISION=${FOLIO_RESEARCH_REVISION:?set FOLIO_RESEARCH_REVISION}
mkdir -p build/research/backing
nice -n 19 taskset -c 4-11 timeout 900 "$node_bin" --max-old-space-size=128 scripts/research/backing.ts build/research/backing/ryzen 9 > build/research/backing/run.log 2>&1
printf '%s\n' complete > build/research/backing/finished
