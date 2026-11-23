#!/bin/bash
# FL CPU-burn question on the rig host: snapshot, deploy folio-floor-c-1122 running floor-worker-cpu.mjs,
# tail, C=0 smoke, drive the fresh arms and the warm arm, analyse, copy records, tear down, snapshot.
# Run detached: nohup setsid bash floor-cpu-run.sh > run.out 2>&1 &
W=folio-floor-c-1122
RIG="${RIG_DIR:-$HOME/floor-rig}"
RUN=$(date -u +%Y%m%dT%H%M%S)
DONE="$RIG/DONE-cpu-$W-$RUN"
cd "$RIG" || exit 1
source "$HOME/.bashrc" > /dev/null 2>&1
TAILPID=""
RC=1

finish() {
	[ -n "$TAILPID" ] && kill "$TAILPID" 2> /dev/null
	sleep 5
	mkdir -p "/tmp/cpu-$W-$RUN"
	cp -p out/cpu.jsonl out/warm.jsonl tail.jsonl driver.log deploy.log smoke.log "/tmp/cpu-$W-$RUN/" 2> /dev/null
	echo "records copied to /tmp/cpu-$W-$RUN"
	wrangler delete --name "$W" --force > teardown-cpu.log 2>&1
	echo "teardown rc=$?"
	node floor-snap.mjs after
	grep -q "\"$W\"" snap-after.json && echo "own worker still present" || echo "own worker absent after teardown"
	echo "rc=$RC run=$RUN" > "$DONE"
}
node floor-snap.mjs before || exit 1
if grep -q "\"$W\"" snap-before.json; then
	echo "$W already exists; stop"
	exit 1
fi
trap finish EXIT

mkdir -p out
wrangler deploy --config floor-wrangler-cpu.jsonc > deploy.log 2>&1 || {
	echo "deploy failed"
	exit 1
}
WORKER_URL=$(grep -o 'https://[^ ]*workers.dev' deploy.log | head -1)
[ -n "$WORKER_URL" ] || {
	echo "no url in deploy log"
	exit 1
}

wrangler tail "$W" --format json > tail.jsonl 2> tail.err &
TAILPID=$!
sleep 90

WORKER_URL="$WORKER_URL" node floor-cpu-smoke.mjs > smoke.log 2>&1
SMOKE_RC=$?
cat smoke.log
[ "$SMOKE_RC" -eq 0 ] || {
	RC=2
	echo "smoke failed rc=$SMOKE_RC; stop, no driver"
	exit 2
}

WORKER_URL="$WORKER_URL" OUT="$RIG/out" node floor-cpu-driver.mjs > driver.log 2>&1
RC=$?
cat driver.log
echo "driver rc=$RC"
sleep 15
