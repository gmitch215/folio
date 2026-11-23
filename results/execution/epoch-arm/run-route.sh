#!/bin/sh
# usage: run-route.sh <nativecount|epcount|plain> <site> <workload> <tag>
# One render in the rig container with the counting harness mounted over the rig's bench build file.
#   nativecount: untranslated module, instrumented count module through COUNT_WASM
#   epcount:     the epoch arm with counters
#   plain:       untranslated module with the harness only
# Paths are placeholders:
#   RIG         the copied rig directory (holds counts/ with the harness, counts/out/)
#   USERS_TREE  the rig's user-files tree, mounted as /Users in the container
#   CENSUS      the census directory as the container sees it (under the /Users mount)
#   IMAGE       the rig container image
#   TIMING_LOCK the box-wide timing lock directory; counting runs wait for it to clear
set -u
kind=$1; site=$2; workload=$3; tag=$4
RIG=${RIG:?set RIG}
USERS_TREE=${USERS_TREE:?set USERS_TREE}
CENSUS=${CENSUS:?set CENSUS}
IMAGE=${IMAGE:?set IMAGE}
TIMING_LOCK=${TIMING_LOCK:-/tmp/timing.lock}
out=$RIG/counts/out
mkdir -p "$out"
while [ -d "$TIMING_LOCK" ]; do sleep 30; done
extra="-v $RIG/counts/bench.epcount.mjs:$CENSUS/build/bench.mjs:ro -v $RIG/counts:/work/counts:ro"
mode=native
case "$kind" in
	nativecount) extra="$extra -e COUNT_WASM=/work/counts/count.wasm" ;;
	epcount) mode=ep-heap32-count ;;
	plain) ;;
	*) echo "unknown kind $kind"; exit 2 ;;
esac
log="$out/$kind-$site-$workload-$tag.log"
echo "$(date -u +%FT%TZ) start $kind $site:$workload $tag load=$(cut -d' ' -f1-3 /proc/loadavg)" > "$log"
# shellcheck disable=SC2086
nice -n 19 docker run --rm --user "$(id -u):$(id -g)" --memory 12g --cpus 6 \
	-v "$USERS_TREE:/Users" -v "$out:/work/out" $extra \
	-w "$CENSUS" --name "rig-$kind-$site-$workload-$tag" "$IMAGE" \
	node build/bench.mjs --site="$site" --mode="$mode" --workload="$workload" --n=1 --rep="$kind$tag" >> "$log" 2>&1
rc=$?
echo "$(date -u +%FT%TZ) end rc=$rc" >> "$log"
exit $rc
