#!/bin/sh
# usage: loop-full.sh MANIFEST SHARD COUNT ROUNDS   (verifier full options, heavy ground truth)
cd "$FOLIO_ROOT" || exit 1
i=0
while [ "$i" -lt "$4" ]; do
	VFULL=1 LIMIT_MS=90000 nice -n 10 /opt/homebrew/opt/node/bin/node scratchpad/v11/w1/adv4/run.ts "$1" "$2" "$3" 20 heavy >> "scratchpad/v11/w1/adv4/results/log-$1-$2.txt" 2>&1
	if tail -1 "scratchpad/v11/w1/adv4/results/log-$1-$2.txt" | grep -q "left 0,"; then break; fi
	i=$((i + 1))
done
echo finished >> "scratchpad/v11/w1/adv4/results/log-$1-$2.txt"
