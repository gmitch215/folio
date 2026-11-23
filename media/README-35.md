# Alarm Retirement

Does an isolate retirement at an event boundary turn an alarm that is due within about a second into a
storage reset? The experiment runs bare Durable Objects on the SQLite storage layer. Each arm changes
where and how the alarm is set during an event, then counts storage resets on the first event of a
fresh object and on chains of up to 24 events.

The measurements show which alarm shapes reset and which do not. They do not show the mechanism. The
storage layer is closed source, so the arms describe behavior only.

## Layout

| Path                           | What it is                                                    |
| ------------------------------ | ------------------------------------------------------------- |
| `worker.mjs`, `wrangler.jsonc` | the bare Durable Object, one arm per query string             |
| `first-event.ts`               | driver for one first event per fresh object, with a read-back |
| `chain.ts`                     | driver for chains of up to 24 events on one object name       |
| `summarize.ts`                 | prints the first-event and chain tables for one run directory |

## Arms

Each event writes a marker row, burns CPU, and writes an effect row. The `no-writes` arm burns CPU and
writes nothing. All arms share one worker and one alarm handler. The handler sets the next alarm 240 s
ahead and writes nothing. The `end-near-unawaited`, `end-far-unawaited` and `alarm-*` arms count their
delay from the time of the call. The two older end arms count it from the start of the event.
`chain.ts` sends the events of an arm whose name ends in `-no-gap` back to back, with no pause between
them. The `alarm-*` arms run on first events only.

| Arm                            | Start of event                                                              | Rows | End of event                                                     | Question                                  |
| ------------------------------ | --------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------- | ----------------------------------------- |
| `no-alarm`                     | nothing                                                                     | yes  | nothing                                                          | control; the alarm is never set           |
| `start-near-awaited`           | read the alarm; if none, or later than now + 50 ms, await set to now + 1 ms | yes  | nothing                                                          | an alarm set and awaited before the event |
| `start-near-unawaited`         | as `start-near-awaited`, without the await                                  | yes  | nothing                                                          | does awaiting the move matter             |
| `start-near-awaited-end-sync`  | as `start-near-awaited`                                                     | yes  | await sync                                                       | does a commit after the write help        |
| `start-near-awaited-no-writes` | as `start-near-awaited`                                                     | no   | nothing                                                          | does the reset need row writes            |
| `start-5s-awaited`             | as `start-near-awaited`, set to now + 5 s when the test passes              | yes  | nothing                                                          | alarm distance                            |
| `end-sync-then-near`           | nothing                                                                     | yes  | await sync, then set to now + 1 ms without await                 | commit before the alarm move              |
| `end-near-awaited-then-sync`   | nothing                                                                     | yes  | await set to now + 1 ms, then await sync                         | alarm move before the commit              |
| `end-near-unawaited`           | nothing                                                                     | yes  | set to now + 1 ms without await or sync                          | an alarm set last, with no commit after   |
| `end-far-unawaited`            | nothing                                                                     | yes  | set to now + 60 s without await or sync                          | alarm distance at the end of the event    |
| `end-near-unawaited-no-gap`    | nothing                                                                     | yes  | as `end-near-unawaited`, events back to back                     | does the 0.5 s gap matter                 |
| `alarm-1ms` to `alarm-60s`     | nothing                                                                     | yes  | set to now + 1 ms, 10 ms, 100 ms, 1 s, 5 s or 60 s without await | alarm distance on a first event           |

## Running

The drivers read their inputs from the environment. Nothing is hardcoded.

| Variable       | Used by      | Meaning                                              |
| -------------- | ------------ | ---------------------------------------------------- |
| `WORKER_URL`   | both drivers | base URL of the deployed Worker (required)           |
| `OUT`          | both drivers | directory for the JSONL output (required)            |
| `ARMS`         | both drivers | comma-separated arm names; each driver has a default |
| `SAMPLES`      | both drivers | objects per arm, default 20                          |
| `GAP`          | both drivers | milliseconds between requests, default 1500 and 500  |
| `EVENTS`       | `chain.ts`   | events per chain, default 24                         |
| `CONC`         | `chain.ts`   | chains in flight at once, default 4                  |
| `MAX_REQUESTS` | both drivers | stop after this many requests, default 7000          |

```sh
npx wrangler deploy --config experiments/alarm-retirement/wrangler.jsonc
WORKER_URL=$WORKER_URL OUT=runs/first-event bun experiments/alarm-retirement/first-event.ts
WORKER_URL=$WORKER_URL OUT=runs/chain bun experiments/alarm-retirement/chain.ts
bun experiments/alarm-retirement/summarize.ts runs/chain
```

`summarize.ts` takes one directory. Point it at a directory that holds `first-event.jsonl`, `chain.jsonl`,
or both. Run the first-event driver and the chain driver into the same directory to get both tables
from one run. Remove the Worker with `npx wrangler delete` when the run ends.

## Results

One measurement set. All arms ran on one deployed Worker with one alarm handler, first events first and
chains second. Rates are counts over 20 samples per arm, with Wilson 95% intervals.

### First Event

Each sample is a fresh object. The first event runs once, and a read-back from a fresh stub 3 s later
reads the marker and effect rows and the alarm time. A reset is a storage reset error on the event. The
state columns count the reset samples by which rows the read-back found: both, neither, marker only,
effect only.

| Arm                           | Reset rate (95%)       | Reset samples, both/neither/marker/effect | Alarm ahead at read-back (median, ms) |
| ----------------------------- | ---------------------- | ----------------------------------------- | ------------------------------------- |
| `no-alarm`                    | 0/20 [0.00%, 16.11%]   | 0/0/0/0                                   | not set                               |
| `start-near-awaited`          | 16/20 [58.40%, 91.93%] | 15/1/0/0                                  | 237136                                |
| `start-near-unawaited`        | 14/20 [48.10%, 85.45%] | 14/0/0/0                                  | 237161                                |
| `start-near-awaited-end-sync` | 16/20 [58.40%, 91.93%] | 12/4/0/0                                  | 237162                                |
| `start-5s-awaited`            | 0/20 [0.00%, 16.11%]   | 0/0/0/0                                   | 536                                   |
| `end-sync-then-near`          | 0/20 [0.00%, 16.11%]   | 0/0/0/0                                   | 236015                                |
| `end-near-awaited-then-sync`  | 16/20 [58.40%, 91.93%] | 14/2/0/0                                  | 237161                                |
| `alarm-1ms`                   | 14/20 [48.10%, 85.45%] | 12/2/0/0                                  | 237113                                |
| `alarm-10ms`                  | 13/20 [43.29%, 81.88%] | 11/2/0/0                                  | 237079                                |
| `alarm-100ms`                 | 14/20 [48.10%, 85.45%] | 13/1/0/0                                  | 237148                                |
| `alarm-1s`                    | 16/20 [58.40%, 91.93%] | 14/2/0/0                                  | 237129                                |
| `alarm-5s`                    | 0/20 [0.00%, 16.11%]   | 0/0/0/0                                   | 569                                   |
| `alarm-60s`                   | 0/20 [0.00%, 16.11%]   | 0/0/0/0                                   | 55521                                 |

Only 4 to 7 events per reset arm read back ok, so the instance-change column is not reported for them.
The arms without a reset changed instance before the read-back on 20 of 20 samples (`start-5s-awaited`),
11 (`end-sync-then-near`), 13 (`no-alarm`), 9 (`alarm-5s`) and 15 (`alarm-60s`).

### Chains

Each chain uses one object name. Up to 24 events run in order, 0.5 s apart except in
`end-near-unawaited-no-gap`, with a 0.25 s nominal burn per event. A retirement is an ok event whose
isolate id differs from the previous ok event on the same chain. A reset is a storage reset error on
the event.

| Arm                            | Chains with a reset (95%) | Resets | Retirements | Resets per retirement | First retirement or reset, event (median, min to max, n) | Ok events | Other events |
| ------------------------------ | ------------------------- | -----: | ----------: | --------------------: | -------------------------------------------------------- | --------: | -----------: |
| `no-alarm`                     | 0/20 [0.00%, 16.11%]      |      0 |           9 |                  0.00 | 22 (16 to 24, n 9)                                       |       480 |            0 |
| `start-near-awaited`           | 9/20 [25.82%, 65.79%]     |      9 |           9 |                  1.00 | 22 (18 to 23, n 9)                                       |       471 |            0 |
| `start-near-unawaited`         | 6/20 [14.55%, 51.90%]     |      6 |           6 |                  1.00 | 22 (16 to 23, n 6)                                       |       474 |            0 |
| `start-near-awaited-end-sync`  | 9/20 [25.82%, 65.79%]     |      9 |           9 |                  1.00 | 21 (18 to 23, n 9)                                       |       471 |            0 |
| `start-near-awaited-no-writes` | 10/20 [29.93%, 70.07%]    |     10 |          10 |                  1.00 | 21 (18 to 23, n 10)                                      |       470 |            0 |
| `start-5s-awaited`             | 0/20 [0.00%, 16.11%]      |      0 |           8 |                  0.00 | 22 (18 to 24, n 8)                                       |       480 |            0 |
| `end-sync-then-near`           | 0/20 [0.00%, 16.11%]      |      0 |          13 |                  0.00 | 22 (18 to 24, n 13)                                      |       480 |            0 |
| `end-near-awaited-then-sync`   | 9/20 [25.82%, 65.79%]     |      9 |          10 |                  0.90 | 19 (12 to 23, n 10)                                      |       471 |            0 |
| `end-near-unawaited`           | 6/20 [14.55%, 51.90%]     |      6 |           6 |                  1.00 | 22 (16 to 23, n 6)                                       |       474 |            0 |
| `end-far-unawaited`            | 0/20 [0.00%, 16.11%]      |      0 |          11 |                  0.00 | 22 (14 to 24, n 11)                                      |       480 |            0 |
| `end-near-unawaited-no-gap`    | 11/20 [34.21%, 74.18%]    |     11 |          11 |                  1.00 | 22 (17 to 23, n 11)                                      |       469 |            0 |

Isolate changes by event index, on ok events:

| Arm                            | 1 to 3 | 4 to 6 | 7 to 12 | 13 to 24 |
| ------------------------------ | -----: | -----: | ------: | -------: |
| `no-alarm`                     |   0/60 |   0/60 |   0/120 |    9/240 |
| `start-near-awaited`           |   0/60 |   0/60 |   0/120 |    9/231 |
| `start-near-unawaited`         |   0/60 |   0/60 |   0/120 |    6/234 |
| `start-near-awaited-end-sync`  |   0/60 |   0/60 |   0/120 |    9/231 |
| `start-near-awaited-no-writes` |   0/60 |   0/60 |   0/120 |   10/230 |
| `start-5s-awaited`             |   0/60 |   0/60 |   0/120 |    8/240 |
| `end-sync-then-near`           |   0/60 |   0/60 |   0/120 |   13/240 |
| `end-near-awaited-then-sync`   |   0/60 |   0/60 |   1/119 |    9/232 |
| `end-near-unawaited`           |   0/60 |   0/60 |   0/120 |    6/234 |
| `end-far-unawaited`            |   0/60 |   0/60 |   0/120 |   11/240 |
| `end-near-unawaited-no-gap`    |   0/60 |   0/60 |   0/120 |   11/229 |

In each reset chain, no ok event before the first reset changed isolate id. Retirements occur without a
reset in `no-alarm`, `start-5s-awaited`, `end-sync-then-near` and `end-far-unawaited`.

### Reading the Results

- With an awaited alarm move at the start of the event, the reset occurred in 9 of 20 chains. Without
  the await it occurred in 6 of 20. The intervals overlap, so the two counts do not separate.
- Removing the row writes left the count at 10 of 20 chains. A sync after the start move left it at 9
  of 20.
- Moving the alarm to 5 s at the start, setting it to 1 ms after a sync, and setting it to 60 s at the
  end each gave 0 of 20 chains with a reset. All three arms still retired isolates.
- Setting the alarm to 1 ms at the end of the event gave 6 of 20 chains with a reset without a sync,
  and 9 of 20 with an awaited set followed by a sync. With events sent back to back, it gave 11 of 20.
- On first events, alarms 1 ms to 1 s ahead reset in 13 to 16 of 20 samples. Alarms 5 s and 60 s ahead
  reset in 0 of 20.
- The first retirement or reset fell at a median of event 19 to 22 across the arms that had one.

## Limits

- Bare objects, one account plan, and one run. Each arm has 20 samples, so an interval that covers
  another arm's rate does not separate the two.
- Other work on the same account ran during the measurement. Its load is not controlled or recorded.
- The 1.5 s first-event burn and the 0.25 s chain burn are nominal. CPU time is not measured, and the
  nominal CPU at reset is not summarised here.
- No mechanism is shown. The arms show when resets happen in these shapes. They do not show why.
- No client-side `fetch failed` event occurred in this run. One without a Worker reply would count as
  an other event and not as a reset.
- Of the 119 first-event reset samples, 14 read back with neither the marker nor the effect row
  present. The cause is not known.
