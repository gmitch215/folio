#!/bin/bash
# sync on the rig host: snapshot, deploy folio-reset-sync-1123, tail, settle, run sync-driver.mjs, copy records, tear down, snapshot.
# usage: nohup setsid bash sync-run.sh smoke|full > run.out 2>&1 &
MODE="${1:-smoke}"
W=folio-reset-sync-1123
RIG="${RIG_DIR:-$HOME/sync-rig}"
RUN=$(date -u +%Y%m%dT%H%M%S)
DONE="$RIG/DONE-sync-$MODE-$RUN"
cd "$RIG" || exit 1
source "$HOME/.bashrc" > /dev/null 2>&1
TAILPID=""
RC=1

finish() {
	[ -n "$TAILPID" ] && kill "$TAILPID" 2> /dev/null
	sleep 5
	mkdir -p "/tmp/sync-$MODE-$RUN"
	cp -p out-$MODE/trials.jsonl tail-$MODE.jsonl driver-$MODE.log deploy-$MODE.log "/tmp/sync-$MODE-$RUN/" 2> /dev/null
	echo "records copied to /tmp/sync-$MODE-$RUN"
	for i in 1 2 3 4 5; do
		wrangler delete --name "$W" --force > teardown-$MODE.log 2>&1
		RCD=$?
		echo "teardown try $i rc=$RCD"
		[ "$RCD" = 0 ] && break
		sleep 20
	done
	for i in 1 2 3 4 5; do
		node floor-snap.mjs after-$MODE && break
		sleep 20
	done
	grep -q "\"$W\"" snap-after-$MODE.json && echo "own worker still present" || echo "own worker absent after teardown"
	echo "rc=$RC run=$RUN" > "$DONE"
}
node floor-snap.mjs before-$MODE || exit 1
if grep -q "\"$W\"" snap-before-$MODE.json; then
	echo "$W already exists; stop"
	exit 1
fi
trap finish EXIT

mkdir -p out-$MODE
wrangler deploy --config sync-wrangler.jsonc > deploy-$MODE.log 2>&1 || {
	echo "deploy failed"
	exit 1
}
WORKER_URL=$(grep -o 'https://[^ ]*workers.dev' deploy-$MODE.log | head -1)
[ -n "$WORKER_URL" ] || {
	echo "no url in deploy log"
	exit 1
}

wrangler tail "$W" --format json > tail-$MODE.jsonl 2> tail-$MODE.err &
TAILPID=$!
sleep 90

WORKER_URL="$WORKER_URL" OUT="$RIG/out-$MODE" MODE="$MODE" node sync-driver.mjs > driver-$MODE.log 2>&1
RC=$?
cat driver-$MODE.log
echo "driver rc=$RC"
sleep 30
