#!/bin/bash
# FL idle-request grid on the rig host: snapshot, deploy folio-floor-b-1122 running floor-worker-idle.mjs,
# tail, smoke with version check, drive the fresh and warm arms, copy records, tear down, snapshot.
# Run detached: nohup setsid bash floor-idle-run.sh > run.out 2>&1 &
W=folio-floor-b-1122
RIG="${RIG_DIR:-$HOME/floor-rig}"
RUN=$(date -u +%Y%m%dT%H%M%S)
DONE="$RIG/DONE-idle-$W-$RUN"
cd "$RIG" || exit 1
source "$HOME/.bashrc" > /dev/null 2>&1
TAILPID=""
RC=1

finish() {
	[ -n "$TAILPID" ] && kill "$TAILPID" 2> /dev/null
	sleep 5
	mkdir -p "/tmp/idle-$W-$RUN"
	cp -p out/trials.jsonl out/chains.jsonl tail.jsonl driver.log deploy.log smoke-*.log versions-*.txt "/tmp/idle-$W-$RUN/" 2> /dev/null
	echo "records copied to /tmp/idle-$W-$RUN"
	wrangler delete --name "$W" --force > teardown.log 2>&1
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
wrangler deploy --config floor-wrangler-idle.jsonc > deploy.log 2>&1 || {
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

SMOKE_RC=1
for attempt in 1 2; do
	SINCE=$(date -u +%s%3N)
	WORKER_URL="$WORKER_URL" node floor-smoke.mjs > "smoke-$attempt.log" 2>&1
	SMOKE_RC=$?
	cat "smoke-$attempt.log"
	sleep 10
	node floor-versions.mjs "$SINCE" > "versions-$attempt.txt" 2>&1
	VER_RC=$?
	cat "versions-$attempt.txt"
	[ "$VER_RC" -eq 0 ] || {
		RC=2
		echo "version check rc=$VER_RC; stop, no retry"
		exit 2
	}
	[ "$SMOKE_RC" -ne 3 ] && break
	[ "$attempt" -eq 1 ] && {
		echo "smoke hit the code-updated reset; retry in 60 s"
		sleep 60
	}
done
[ "$SMOKE_RC" -eq 0 ] || {
	RC=2
	echo "smoke failed rc=$SMOKE_RC"
	exit 2
}

WORKER_URL="$WORKER_URL" OUT="$RIG/out" SAMPLES=10 CONC=6 CHAINS=5 EVENTS=24 \
	node floor-driver.mjs > driver.log 2>&1
RC=$?
echo "driver rc=$RC"
