#!/bin/sh
# usage: loop.sh MANIFEST SHARD COUNT ROUNDS
# each node run stops taking new modules after 35 s and a module is cut at 80 s, so one run is under 120 s
cd "$FOLIO_ROOT" || exit 1
i=0
while [ "$i" -lt "$4" ]; do
	LIMIT_MS=80000 nice -n 10 /opt/homebrew/opt/node/bin/node <plan file>/adv4/run.ts "$1" "$2" "$3" 35 >> "<plan file>/adv4/results/log-$1-$2.txt" 2>&1
	if grep -q "left 0," "<plan file>/adv4/results/log-$1-$2.txt" 2>/dev/null && tail -1 "<plan file>/adv4/results/log-$1-$2.txt" | grep -q "left 0,"; then break; fi
	i=$((i + 1))
done
echo finished >> "<plan file>/adv4/results/log-$1-$2.txt"
