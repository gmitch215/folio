#!/bin/bash
# FL pre-loop variant probe on the rig host: one deploy of folio-floor-b-1122 running floor-worker-probe2.mjs,
# three requests per variant (A to E), tail, report, teardown, snapshot.
# Run detached: nohup setsid bash floor-probe2-run.sh > run.out 2>&1 &
W=folio-floor-b-1122
RIG="${RIG_DIR:-$HOME/floor-rig}"
RUN=$(date -u +%Y%m%dT%H%M%S)
DONE="$RIG/DONE-probe2-$W-$RUN"
cd "$RIG" || exit 1
source "$HOME/.bashrc" > /dev/null 2>&1
TAILPID=""
RC=1

finish() {
	[ -n "$TAILPID" ] && kill "$TAILPID" 2> /dev/null
	sleep 5
	mkdir -p "/tmp/probe2-$W-$RUN"
	cp -p out/probe2.jsonl tail.jsonl deploy.log probe2-driver.log probe2-report.txt "/tmp/probe2-$W-$RUN/" 2> /dev/null
	echo "records copied to /tmp/probe2-$W-$RUN"
	wrangler delete --name "$W" --force > teardown-probe2.log 2>&1
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
wrangler deploy --config floor-wrangler-probe2.jsonc > deploy.log 2>&1 || {
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

WORKER_URL="$WORKER_URL" OUT="$RIG/out" node floor-probe2.mjs > probe2-driver.log 2>&1
RC=$?
cat probe2-driver.log
sleep 10
node floor-probe2-report.mjs "$RIG/out/probe2.jsonl" "$RIG/tail.jsonl" > probe2-report.txt 2>&1
cat probe2-report.txt
echo "probe2 driver rc=$RC"
