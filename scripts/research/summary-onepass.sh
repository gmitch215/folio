#!/usr/bin/env bash
# one-pass shared, one-pass copied, two-pass shared and serial on the Linux rig, one fresh process per cell
# usage: summary-onepass.sh STREAM.wasm OUTPUT_DIRECTORY
# needs FOLIO_RIG_NODE; STREAM.wasm comes from summary-certify.ts; WIDTHS narrows the widths (default 1 2 4 8)
# without taskset (macOS) the cells run unpinned at nice 19 and the memory line is skipped
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
binary=$(realpath "${1:?usage: summary-onepass.sh STREAM.wasm OUTPUT_DIRECTORY}")
[ ! -e "${2:?usage: summary-onepass.sh STREAM.wasm OUTPUT_DIRECTORY}" ] || {
	echo "refusing to overwrite $2" >&2
	exit 1
}
mkdir -p "$2"
out=$(cd "$2" && pwd)
node_bin=${FOLIO_RIG_NODE:?set FOLIO_RIG_NODE}
pin="nice -n 19"
command -v taskset > /dev/null && pin="nice -n 19 taskset -c 4-11"
for session in 1 2 3; do
	for mib in 8 64; do
		for width in ${WIDTHS:-1 2 4 8}; do
			cell=s$session-m$mib-w$width
			until mkdir /tmp/folio-timing.lock 2> /dev/null; do sleep 20; done
			{
				date -u +%FT%TZ
				uptime
				command -v free > /dev/null && free -m | sed -n 2p
			} > "$out/$cell.before.log"
			# shellcheck disable=SC2086
			FOLIO_WIDTH=$width FOLIO_MIB=$mib FOLIO_ROUNDS=5 FOLIO_SUMMARY_BINARY=$binary \
				$pin timeout 900 "$node_bin" --max-old-space-size=2048 \
				scripts/research/summary-probe.ts "$out/$cell.json" > "$out/$cell.log" 2>&1
			rc=$?
			{
				date -u +%FT%TZ
				uptime
				echo "rc=$rc"
			} > "$out/$cell.after.log"
			rmdir /tmp/folio-timing.lock
			echo "s$session m$mib w$width rc=$rc" >> "$out/progress.log"
		done
	done
done
echo complete > "$out/finished"
