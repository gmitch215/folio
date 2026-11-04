#!/usr/bin/env bash
# certification cost and steady calls of the certified route, one fresh process per cell
# usage: certify-cost.sh SUBJECT_DIRECTORY OUTPUT_DIRECTORY
# needs FOLIO_RIG_NODE; SUBJECT_DIRECTORY holds crc32c.wasm, crc16.wasm, crc64.wasm, poly31.wasm, lcg.wasm and
# miniz-crc32.wasm (export mz_crc32); SUBJECTS lists other NAME:ENTRY pairs (adler32, xlcg and so on); WIDTH sets
# the workers (default 8); without taskset the cells run unpinned
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
subjects=$(realpath "${1:?usage: certify-cost.sh SUBJECT_DIRECTORY OUTPUT_DIRECTORY}")
[ ! -e "${2:?usage: certify-cost.sh SUBJECT_DIRECTORY OUTPUT_DIRECTORY}" ] || {
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
		for pair in ${SUBJECTS:-crc32c:crc32c crc16:crc16 crc64:crc64 poly31:poly31 lcg:lcg miniz-crc32:mz_crc32}; do
			name=${pair%%:*}
			entry=${pair##*:}
			cell=s$session-m$mib-$name
			until mkdir /tmp/folio-timing.lock 2> /dev/null; do sleep 20; done
			{
				date -u +%FT%TZ
				uptime
			} > "$out/$cell.before.log"
			# shellcheck disable=SC2086
			FOLIO_WIDTH=${WIDTH:-8} FOLIO_MIB=$mib FOLIO_ROUNDS=7 \
				$pin timeout 900 "$node_bin" --max-old-space-size=2048 \
				scripts/research/certify-cost.ts "$subjects/$name.wasm" "$entry" "$out/$cell.json" \
				> "$out/$cell.log" 2>&1
			rc=$?
			rmdir /tmp/folio-timing.lock
			echo "s$session m$mib $name rc=$rc" >> "$out/progress.log"
		done
	done
done
echo complete > "$out/finished"
