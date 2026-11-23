#!/bin/sh
# usage: run-route.sh <plain|count> <site> <workload> <tag>
# One native render in the rig container. Count mode mounts the counting harness over the rig's
# bench build file and points COUNT_WASM at the instrumented module. Paths are placeholders:
#   RIG      the copied rig directory (holds counts/ and counts/out/)
#   USERS_TREE the rig's user-files tree, mounted as /Users in the container
#   CENSUS   the census directory as the container sees it (under the /Users mount)
#   IMAGE    the rig container image
#   TIMING_LOCK  the box-wide timing lock directory; counting runs wait for it to clear
set -u
mode=$1; site=$2; workload=$3; tag=$4
RIG=${RIG:?set RIG}
USERS_TREE=${USERS_TREE:?set USERS_TREE}
CENSUS=${CENSUS:?set CENSUS}
IMAGE=${IMAGE:?set IMAGE}
TIMING_LOCK=${TIMING_LOCK:-/tmp/timing.lock}
out=$RIG/counts/out
mkdir -p "$out"
while [ -d "$TIMING_LOCK" ]; do sleep 30; done
extra=
if [ "$mode" = count ]; then
	extra="-v $RIG/counts/bench.count.mjs:$CENSUS/build/bench.mjs:ro -v $RIG/counts:/work/counts:ro -e COUNT_WASM=/work/counts/php8.5.tuned.count.wasm"
fi
log="$out/$mode-$site-$workload-$tag.log"
echo "$(date -u +%FT%TZ) start $mode $site:$workload $tag load=$(cut -d' ' -f1-3 /proc/loadavg)" > "$log"
# shellcheck disable=SC2086
nice -n 19 docker run --rm --user "$(id -u):$(id -g)" --memory 12g --cpus 6 \
	-v "$USERS_TREE:/Users" -v "$out:/work/out" -v "$RIG/counts:/work/counts:ro" $extra \
	-w "$CENSUS" --name "rig-$mode-$site-$workload-$tag" "$IMAGE" \
	node build/bench.mjs --site="$site" --mode=native --workload="$workload" --n=1 --rep="$mode$tag" >> "$log" 2>&1
rc=$?
echo "$(date -u +%FT%TZ) end rc=$rc" >> "$log"
exit $rc
