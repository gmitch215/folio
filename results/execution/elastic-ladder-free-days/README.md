# Elastic Ladder Free Days

Question: can the 192 MiB dense fixture run in one Durable Object on the Free plan with pages held in the object's own SQLite (V4) or behind a compressed pool (V6), and do the gate rules fixed before day 2 hold?

Result: G-E2 is NOT MET on days 1 and 2. Every completed run on both days is byte-exact.

- Day 1 (UTC 10 November): ten completed runs, all in colo IAD. Dense wall times were 5,068.3, 2,666.0 and 2,612.2 ms for V4 and 2,495.4, 3,372.3 and 2,914.3 ms for V6. Four failed attempts: three first-attempt `init` failures with an edge HTML 404 or 500 right after `/ready`, and one `run` call that returned after 1,012,566.8 ms against a 150 s client abort. The cause of the last is not found.
- Day 2 (UTC 11 November): V4 dense 2,542.6 and 3,638.3 ms, V6 dense 3,749.3 and 3,067.1 ms, in colos IAD and EWR. The unpaged run at 768 pages took 126.4 ms (EWR) against 736.3 ms for V4 with 768 frames (IAD), 5.825x for one pair, and V4 with 64 frames took 978.3 ms (EWR, after a first attempt that failed with an edge 404 at `init`), 7.74x. V4 writes 768 rows at the end of each of those requests. The time model (day 2 predictions, hash `36f4508aec17d5557a8ddfcf7d6a45dfca8eb94ae3a9a50cdb760b0ef3ac0694` of `experiments/elastic-ladder/day2-predictions-nnls.json`) over-predicts chase on V4 by 126.6% (3,587.6 ms predicted, 1,582.9 measured) and on V6 by 22.3% (1,773.1 against 1,449.2).

The dense p90 rule (under 10 s, failed attempts counted as over) fails because the four day 1 failures count as over, although every completed dense run took at most 5.1 s.

## Inputs

`raw/<run>-raw.jsonl` is the client record of one invocation (`level` `client`, `op` `init`, `run`, `verify` or `clear`, `wallMs`, `colo`, `exact`, the pager counters), with `heartbeat` lines on day 2. The 14 invocations of day 1 start with `2026-11-10T` and the 10 of day 2 with `2026-11-11T00-`. `raw/<run>-budget.json` is the planned rows and caps, `raw/<run>-counters.json` the counted rows, `raw/<run>-cleanup.json` the account check after teardown and `raw/<run>-source.json` the deployed module digests. The repository redaction scan found nothing in these records: they carry no account identifier, token or workers.dev name.

## Instrument

`node experiments/elastic-ladder/live.ts --variants V --workloads W --row-cap N --approved`, one invocation per cell, run from the Mac. Run wall time is server-side, measured around the object's `run` call. The client adds one round trip.

## Limits

The Free plan allows 100,000 Durable Object rows a day, and the platform meter undercounts, so the counter is the budget. The extra repeats of day 2 (UTC 11 November, after 03:00) and the STUDENT account's repeats raise the dense repeat count per arm. They are not exported here and do not change a NOT MET reading. The Paid account series on 11 November is a supplementary record of a different plan and is not part of this study. Day 3 was pre-registered and not run, so the gate stays open.
