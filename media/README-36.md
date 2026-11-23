# Idle Requests

Does a request that holds a bare Durable Object idle for 2 to 8 s reset it when its alarm is set 1 to 15 s
ahead of the request start?

## Instrument

A Durable Object class (`experiments/alarm-retirement/floor-worker-idle.mjs`, config `floor-wrangler-idle.jsonc`).
Each request runs the site's pre-loop shape: three writes, then an unawaited `setAlarm(start + F)`. It then waits
in 250 ms timer steps until `L` seconds of wall time have passed, with no CPU burn, and writes once more. The
driver is `floor-driver.mjs`, run by `floor-idle-run.sh`. The analysis is `floor-analyze.mjs`.

The probe is `floor-worker-probe3.mjs` with `floor-probe3.mjs`. Its report is `floor-probe2-report.mjs`. It is
a four-cell check of the same request shape before the grid ran.

Files:

- `raw-trials.jsonl`: one row per fresh trial (`L`, `F`, the outcome and the alarm delay).
- `raw-chains.jsonl`: one row per warm chain of 24 back-to-back events.
- `raw-tail.jsonl`: invocation records for the grid, trimmed (see Limits).
- `raw-probe.jsonl` and `raw-tail-probe.jsonl`: the probe's rows and its trimmed tail.
- `summary.txt`: `floor-analyze.mjs` on the grid. `summary-probe.txt`: the probe report.

## Design

| Arm   | Cells                                   | Objects per cell | Trials or chains | Requests in flight |
| ----- | --------------------------------------- | ---------------: | ---------------: | -----------------: |
| Fresh | L in {2, 4, 8} x F in {1, 5, 10, 15}    | 10               | 120 trials       | 6                  |
| Warm  | L in {2, 4, 8} x F in {5, 10, 15}       | 5 chains         | 45 chains, 1,080 events | 6           |
| Probe | (L, F) in {(2, 15), (8, 15), (2, 1), (8, 5)} | 3           | 12 requests      | 1                  |

`L` is the request's wall time. `F` is the alarm's delay from the request start. The grid's (L = 2, F = 1) cell
is the positive control: its alarm fires inside the request.

## Results

Fresh arm. Each cell has 10 objects. The interval is Wilson 95%.

| L (s) | F (s) | Resets | Interval        | Alarm fired inside the request |
| ----: | ----: | -----: | --------------- | -----------------------------: |
| 2     | 1     | 0 of 10 | 0.0% to 27.8%  | 10 of 10                       |
| 2     | 5     | 0 of 10 | 0.0% to 27.8%  | 0 of 10                        |
| 2     | 10    | 0 of 10 | 0.0% to 27.8%  | 0 of 9                         |
| 2     | 15    | 0 of 10 | 0.0% to 27.8%  | 0 of 10                        |
| 4     | 1     | 0 of 10 | 0.0% to 27.8%  | 10 of 10                       |
| 4     | 5     | 0 of 10 | 0.0% to 27.8%  | 0 of 8                         |
| 4     | 10    | 0 of 10 | 0.0% to 27.8%  | 0 of 9                         |
| 4     | 15    | 0 of 10 | 0.0% to 27.8%  | 0 of 9                         |
| 8     | 1     | 0 of 10 | 0.0% to 27.8%  | 10 of 10                       |
| 8     | 5     | 0 of 10 | 0.0% to 27.8%  | 10 of 10                       |
| 8     | 10    | 0 of 10 | 0.0% to 27.8%  | 0 of 10                        |
| 8     | 15    | 0 of 10 | 0.0% to 27.8%  | 0 of 8                         |

Fisher's exact test of each cell against F = 15 at the same L gives p = 1.0 in all nine comparisons. Every
fresh request returned status 200 with `actualMs` within about 1 s of `L`.

Warm arm. 45 chains, 1,080 events, 0 resets, 0 isolate changes. Every warm cell is 5 chains of 24 events.

Probe. All 12 requests returned status 200. `actualMs` was within 1 s of `L` in every request (2,001 to 2,002 ms
at L = 2, 8,001 to 8,003 ms at L = 8). No request reset, and the alarm handler logged for all 12 objects.

## Reading

With the alarm set 1 to 15 s ahead, a 2 to 8 s idle request did not reset a fresh or warm bare object in these
165 objects. The alarm fired inside the request in the F < L cells, and the request still returned ok.

The grid cannot separate a margin effect from the absence of one. Its positive control, (L = 2, F = 1), reset
0 of 10 times, so this request shape did not produce a reset in this grid. The margin rule (F - L under 5 s
predicts a reset) matched the observed rates in 5 of 12 cells. The F under 5 s rule matched in 9 of 12. Both
matches come from cells with zero resets, so neither rule is tested.

The companion CPU study (`cpu-bare-objects`) reset bare objects after real CPU use, which this request shape
did not contain.

## Limits

- One account, one deployment, one run in November 2026. The platform's alarm and reset policy may change.
- The positive control did not fire. A zero result in this grid is a result about this shape, and it does not
  establish a margin rule either way.
- The warm arm has no F = 1 cells, and its per-cell counts are 5 chains. Retirements were 0 in every cell, so
  reset rates for warm objects are not estimated.
- The probe has 3 objects per cell. Its report reads the alarm handler log, which can fire after the request
  ends, so "alarm logged" does not mean "alarm fired inside the request".
- The tail was trimmed with `tail-trim.mjs`. The `tail records` count in `summary.txt` counts the trimmed records
  (1,214), not the 2,281 records in the full tail. The analysis lines are otherwise identical.
- The 90-second settle and the smoke gate passed before the driver ran. The smoke gate ran once.

## How to Reproduce

From the repository root, with Node 26 or later:

```sh
d=$(mktemp -d)
cp results/continuation/idle-requests/raw-trials.jsonl "$d/trials.jsonl"
cp results/continuation/idle-requests/raw-chains.jsonl "$d/chains.jsonl"
cp results/continuation/idle-requests/raw-tail.jsonl "$d/tail.jsonl"
node experiments/alarm-retirement/floor-analyze.mjs "$d" > results/continuation/idle-requests/summary.txt
node experiments/alarm-retirement/floor-probe2-report.mjs \
	results/continuation/idle-requests/raw-probe.jsonl \
	results/continuation/idle-requests/raw-tail-probe.jsonl \
	> results/continuation/idle-requests/summary-probe.txt
```

The raw tails are made from the `wrangler tail --format json` output of the deployed Worker:

```sh
node experiments/alarm-retirement/tail-trim.mjs <tail.jsonl> > results/continuation/idle-requests/raw-tail.jsonl
```

The deployed runs need a Cloudflare account and the `wrangler` CLI. `floor-idle-run.sh` deploys one Worker, runs
the smoke check and the driver, and deletes the Worker in its exit trap.
