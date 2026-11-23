#!/bin/bash
# usage: run-sweep.sh [reps]   (default 10)
# Proof renders, then the paired timed sweep over the untranslated module, the epoch arm and the
# per-access arm. The timing lock is a directory (mkdir takes it, rmdir releases it), taken after the
# proof step and released by a trap. Paths are placeholders:
#   RIG         the copied rig directory
#   USERS_TREE  the rig's user-files tree, mounted as /Users in the container
#   IMAGE       the rig container image
#   TIMING_LOCK the box-wide timing lock directory
set -u
reps=${1:-10}
RIG=${RIG:?set RIG}
USERS_TREE=${USERS_TREE:?set USERS_TREE}
IMAGE=${IMAGE:?set IMAGE}
lockdir=${TIMING_LOCK:-/tmp/timing.lock}
out=$RIG/tau/out
mkdir -p "$out"
held=0
release() { [ "$held" = 1 ] && rmdir "$lockdir" && held=0; }
trap release EXIT
common=(--rm --user "$(id -u):$(id -g)" --memory 12g --cpus 6
	-v "$USERS_TREE:/Users" -v "$out:/work/out"
	-v "$RIG/tau/run-box.ts:/work/run-box.ts:ro" -v "$RIG/tau/proof.sh:/work/proof.sh:ro" -w /work)
docker run "${common[@]}" "$IMAGE" sh /work/proof.sh native ep-heap32 r-heap32 || exit 1
until mkdir "$lockdir" 2>/dev/null; do sleep 30; done
held=1
docker run "${common[@]}" -e MAX_WAIT_MS=21600000 "$IMAGE" \
	node run-box.ts "$reps" native,ep-heap32,r-heap32 front,login,flush,admin,ladder:1
