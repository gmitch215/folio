#!/bin/bash
# FL isolating probe on the rig host: one deploy of folio-floor-b-1122 running floor-worker-probe.mjs,
# three requests per loop mode (get, wait, both), tail, version check, teardown, snapshot.
# Run detached: nohup setsid bash floor-probe-run.sh > run.out 2>&1 &
W=folio-floor-b-1122
RIG="${RIG_DIR:-$HOME/floor-rig}"
RUN=$(date -u +%Y%m%dT%H%M%S)
DONE="$RIG/DONE-probe-$W-$RUN"
cd "$RIG" || exit 1
source "$HOME/.bashrc" > /dev/null 2>&1
TAILPID=""
RC=1

finish() {
	[ -n "$TAILPID" ] && kill "$TAILPID" 2> /dev/null
	sleep 5
	mkdir -p "/tmp/probe-$W-$RUN"
	cp -p out/probe.jsonl tail.jsonl deploy.log probe-driver.log probe-versions.txt "/tmp/probe-$W-$RUN/" 2> /dev/null
	echo "records copied to /tmp/probe-$W-$RUN"
	wrangler delete --name "$W" --force > teardown-probe.log 2>&1
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
wrangler deploy --config floor-wrangler-probe.jsonc > deploy.log 2>&1 || {
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

SINCE=$(date -u +%s%3N)
WORKER_URL="$WORKER_URL" OUT="$RIG/out" node floor-probe.mjs > probe-driver.log 2>&1
RC=$?
cat probe-driver.log
sleep 10
node floor-versions.mjs "$SINCE" > probe-versions.txt 2>&1
cat probe-versions.txt
echo "probe driver rc=$RC"
