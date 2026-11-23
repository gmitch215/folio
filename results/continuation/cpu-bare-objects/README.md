# CPU Burn on Bare Objects

Does the CPU a request burns on a bare Durable Object set whether it resets at its first storage write after a
yield?

## Instrument

A Durable Object class (`experiments/alarm-retirement/floor-worker-cpu.mjs`, config `floor-wrangler-cpu.jsonc`).
A request makes three writes, then runs a loop of `C` nominal seconds of CPU burn in 250 ms slices. Each slice is
followed by `scheduler.wait(1)`. It ends with one write. The loop has no storage read. The driver is
`floor-cpu-driver.mjs`, run by `floor-cpu-run.sh`. The smoke check is `floor-cpu-smoke.mjs`. The analysis is
`floor-cpu-analyze.mjs`.

The measured CPU per request comes from the Durable Object invocation in `wrangler tail`. Nominal `C` is the
requested burn. Measured CPU is the dose that the table uses.

Files:

- `raw-cpu.jsonl`: one row per fresh request (arm, `C`, class, and the error text when the request reset).
- `raw-warm.jsonl`: one row per warm chain, with its events in order.
- `raw-tail.jsonl`: invocation records from the tail, trimmed (see Limits).
- `summary.txt`: the output of `floor-cpu-analyze.mjs` on these files.

## Design

| Arm   | Nominal C (s)              | Objects per cell | Trials or chains | Notes                                  |
| ----- | -------------------------- | ---------------: | ---------------- | -------------------------------------- |
| none  | 0, 0.25, 0.5, 1, 2, 4      | 10               | 60 trials        | no alarm                               |
| alarm | 0, 0.25, 0.5, 1, 2, 4      | 5                | 30 trials        | unawaited `setAlarm(now + 15 s)` before the loop |
| warm  | 1                          | 5 chains         | 5 chains of 6 events | no alarm, back-to-back requests on one object |

Arms `none` and `alarm` ran shuffled together, one request at a time. The warm arm ran after them.

The storage-yield arm and the alarm-cadence arm were specified but did not run (see Limits).

## Results

Reset rate per nominal `C`, fresh objects. The interval is Wilson 95%. Median measured CPU is the median
Durable Object CPU time for the cell, in milliseconds.

| Arm   | C (s) | n  | Resets | Rate  | Interval        | Median measured CPU (ms) |
| ----- | ----: | -: | -----: | ----: | --------------- | -----------------------: |
| none  | 0     | 10 | 0      | 0.0%  | 0.0% to 27.8%   | 1                        |
| none  | 0.25  | 10 | 0      | 0.0%  | 0.0% to 27.8%   | 315                      |
| none  | 0.5   | 10 | 0      | 0.0%  | 0.0% to 27.8%   | 492                      |
| none  | 1     | 10 | 2      | 20.0% | 5.7% to 51.0%   | 559                      |
| none  | 2     | 10 | 0      | 0.0%  | 0.0% to 27.8%   | 658                      |
| none  | 4     | 10 | 5      | 50.0% | 23.7% to 76.3%  | 1045                     |
| alarm | 0     | 5  | 0      | 0.0%  | 0.0% to 43.4%   | 0                        |
| alarm | 0.25  | 5  | 0      | 0.0%  | 0.0% to 43.4%   | 227                      |
| alarm | 0.5   | 5  | 0      | 0.0%  | 0.0% to 43.4%   | 498                      |
| alarm | 1     | 5  | 0      | 0.0%  | 0.0% to 43.4%   | 526                      |
| alarm | 2     | 5  | 0      | 0.0%  | 0.0% to 43.4%   | 664                      |
| alarm | 4     | 5  | 3      | 60.0% | 23.1% to 88.2%  | 1038                     |

Warm arm, C = 1 s, no alarm. Five chains of six events each. Each chain reset once, at event 2 (one chain), 3
(two chains) or 4 (two chains). The next ok event after each reset had a new isolate id.

Every reset carries the text `Durable Object reset because its code was updated.`, raised at
`floor-worker-cpu.mjs:56:7`, and every reset is marked `codeUpdated=true` in the summary. There are 15 resets in
total: 10 fresh and 5 warm.

Post hoc reading, not a prediction test. The fresh resets separate on measured CPU at about 1 s. The 8 requests
at nominal C = 4 that measured 1,038 ms or more all reset, and the 7 requests at C = 4 below 1,000 ms (882 to 997
ms) were all ok. Two C = 1 resets measured 128 ms and 1,017 ms. The 128 ms reset does not fit the split. This
split was read from these same rows, so it needs a new run to test it.

## Reading

Nominal C is not the dose. At C = 4 the median measured CPU was about 1 s, so one 250 ms slice used about 60 ms
of CPU. Measured CPU is the axis for the comparison.

Resets were rare below C = 2 and about half at C = 4 (8 of 15 fresh requests, with the alarm arm and the none
arm together). The pattern rose with measured CPU but was not monotone: in the none arm, C = 2 had 0 of 10 resets
and C = 4 had 5 of 10. The timer-arm prediction (resets near 0 for C up to 0.5 s and near 1 from C = 2 s) did not hold.
Resets and non-resets overlap in measured CPU below about 1 s.

The alarm arm at C = 4 (3 of 5) against the none arm (5 of 10) does not separate at this n.

## Limits

- The storage-yield arm and the alarm-cadence arm did not run. The second run's smoke gate required the clock
  to advance over storage yields, and it did not. No driver ran, so those arms have no data.
- The warm arm has 5 chains. Per-event CPU for warm requests is partial because the tail lost some invocation
  records. Cumulative CPU per chain is not computed.
- The burn unit was not calibrated. The `cpuMs/slice` column in the summary is measured CPU per slice, not the
  250 ms of the design.
- All resets are code-update resets. This study does not test the storage-reset class of the other studies.
- The 1 s split is post hoc (see Results). It is a hypothesis for a later run.
- The tail was trimmed with `tail-trim.mjs`. The trimmed tail gives the same analyzer output as the full tail.

## How to Reproduce

From the repository root, with Node 26 or later:

```sh
d=$(mktemp -d)
cp results/continuation/cpu-bare-objects/raw-cpu.jsonl "$d/cpu.jsonl"
cp results/continuation/cpu-bare-objects/raw-warm.jsonl "$d/warm.jsonl"
node experiments/alarm-retirement/floor-cpu-analyze.mjs "$d" results/continuation/cpu-bare-objects/raw-tail.jsonl \
	> results/continuation/cpu-bare-objects/summary.txt
```

The raw tail is made from the `wrangler tail --format json` output of the deployed Worker:

```sh
node experiments/alarm-retirement/tail-trim.mjs <tail.jsonl> > results/continuation/cpu-bare-objects/raw-tail.jsonl
```

The deployed run needs a Cloudflare account and the `wrangler` CLI. `floor-cpu-run.sh` deploys one Worker, runs the
smoke check and the driver, and deletes the Worker in its exit trap.
