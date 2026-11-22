# Commit Ladder

Write-size probe for a SQLite-backed Durable Object. The driver sends events of increasing commit size to one object per rung and records which events end in a storage reset, a memory limit, a CPU time limit or a timeout. Each rung and order runs on fresh objects, two by default.

## What It Measures

A `rows` event inserts N rows into one table with one secondary index. Each row holds about 200 bytes of value. A `blob` event inserts N rows of exactly 1 MiB. An `abort` event writes 10 rows and calls `ctx.abort()` on its second event on each instance; it exists as a positive control for the driver.

`ORDERS=plain` writes and returns. `ORDERS=blocked` first runs a synchronous loop of a fixed iteration count, then writes, so a long block precedes the commit.

`END=return` returns after the writes and leaves the commit to the output gate. `END=sync` awaits `storage.sync()` before returning and reports the time it took.

## Running

Deploy the Worker, then point the driver at its URL. Wrangler prints the URL on deploy:

```sh
wrangler deploy --config experiments/commit-ladder/wrangler.jsonc
export WORKER_URL="$DEPLOYED_URL"
node experiments/commit-ladder/ladder.ts
```

The Worker takes its name from `wrangler.jsonc`. Delete it when the run ends:

```sh
wrangler delete --config experiments/commit-ladder/wrangler.jsonc
```

## Options

| Variable      | Default                                                          | Meaning                                                   |
| ------------- | ---------------------------------------------------------------- | --------------------------------------------------------- |
| `WORKER_URL`  | required                                                         | Full URL of the deployed Worker                           |
| `RUNGS`       | `rows:2000,rows:10000,rows:40000,rows:100000,blob:1,...,blob:32` | Comma list of `kind:n`; kinds are `rows`, `blob`, `abort` |
| `ORDERS`      | `plain`                                                          | Comma list of `plain` and `blocked`                       |
| `END`         | `return`                                                         | `return` or `sync`                                        |
| `EVENTS`      | `6`                                                              | Counted events per object per rung and order              |
| `OBJECTS`     | `2`                                                              | Fresh objects per rung and order                          |
| `STOP_AFTER`  | `2`                                                              | Storage resets at one rung that stop climbing the kind    |
| `MAX_WALL_MS` | `180000`                                                         | Client timeout per request; a timeout also stops the kind |
| `BURN`        | `2000000000`                                                     | Loop iterations for `blocked` events                      |
| `OUT`         | `experiments/commit-ladder/runs`                                 | Directory for the JSON output                             |

Each object runs one throwaway event first. A throwaway writes one row, is not counted in the rung, and appears in the output as its own tally.

## Output

The driver prints one line per rung and order with the counted events, the outcome counts, instance changes per object, the median and maximum client wall time, and the storage reset rate with a Wilson 95% interval. It then prints the throwaway tally and the distinct error messages.

The JSON file under `runs/` holds the configuration, every sample and the per-cell tallies. `runs/` is ignored by git. Each sample includes the rows the SQL cursor reports as written (`rowsWritten`), which counts secondary index rows if the platform includes them, and the number of rows the request asked for (`requested`).

## Limits

Client wall time includes the network. In these runs the Workers clock did not advance during a synchronous loop, so the driver's timing is the reference.

`BURN` sets a loop count, not a duration. Calibrate it against the wall time of a `blocked` event before a run.

Instance changes count only between successful events, so a reset that is followed by a failure is seen on the next success.

## Results

One object per cell, six counted events each, after one throwaway event. No cell had a storage reset, memory limit, CPU time limit or timeout. Storage reset rate is 0 of 6 in every cell, with a 95% upper bound of 39%. The blocked cells ran with `BURN=8e8`, not the default of `2000000000`.

| Rung       | Order   | Median wall | Max wall |
| ---------- | ------- | ----------- | -------- |
| rows:2000  | plain   | 100 ms      | 108 ms   |
| rows:10000 | plain   | 193 ms      | 224 ms   |
| rows:40000 | plain   | 471 ms      | 573 ms   |
| rows:10000 | blocked | 732 ms      | 4370 ms  |
| rows:40000 | blocked | 1225 ms     | 5243 ms  |
| blob:1     | plain   | 84 ms       | 165 ms   |
| blob:4     | plain   | 128 ms      | 202 ms   |
| blob:8     | plain   | 123 ms      | 250 ms   |
| blob:16    | plain   | 187 ms      | 306 ms   |
| blob:32    | plain   | 314 ms      | 536 ms   |

Commits of up to 40,000 rows or 32 MiB showed no reset in these cells, which does not rule out a reset rate near 39% at this sample size. Rows at 100,000 per commit were not measured. In the blocked cells, the first two events per object took 3.9 to 5.2 s and later events took 0.7 to 1.2 s. The pilot and calibration each showed one instance change per object, at the first blocked counted event. The blocked repeat showed none. The cause is not established.
