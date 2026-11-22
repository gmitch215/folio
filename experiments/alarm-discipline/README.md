# Alarm Discipline

Does moving a Durable Object alarm earlier inside an event reset the object, and does committing the
event before the alarm moves stop it? Bare arms isolate the platform behavior on a small SQLite-backed
object. A deployed A/B asks the same question of a Drupal site on Durable Objects, switching the alarm
behavior per request.

The background is the workerd storage commit path. A commit that moves the stored alarm earlier first
waits on a synchronous call to the alarm manager, and a failure there breaks the output gate for every
write merged into that commit. A move to a later time takes an asynchronous path that swallows
failures. The production storage layer is closed source, so the arms measure the effect and do not
show the failing call.

## Layout

| Path                           | What it is                                                                  |
| ------------------------------ | --------------------------------------------------------------------------- |
| `worker.mjs`, `wrangler.jsonc` | the bare Durable Object with one arm per query string                       |
| `bare.ts`                      | sequential driver for the bare arms, counts resets per arm                  |
| `micro.ts`                     | driver for the micro-ladder arms, counts failures, resets and client errors |
| `ab.ts`                        | interleaved A/B driver for a deployed Drupal site that meets the contract   |
| `analyze.ts`                   | joins an `ab.ts` run to a `wrangler tail` capture and prints per-arm counts |
| `overlap-worker.mjs`           | the `Overlap` Durable Object for the overlap and first-event arms           |
| `wrangler.overlap.jsonc`       | deploy config for `Overlap`                                                 |
| `overlap.ts`                   | driver for the overlap and first-event arms                                 |
| `bisect-worker.mjs`            | the `Bisect` Durable Object, one feature set per arm                        |
| `wrangler.bisect.jsonc`        | deploy config for `Bisect`                                                  |
| `bisect.ts`                    | driver for the bisect arms                                                  |

## Arms

Each arm runs on its own object, one request at a time. `ITERS` sets the synchronous CPU of an
event. Arms A to D write 20 rows of 32 KiB around the CPU. Arms G to R write 2,000 small rows in 20
slices and read 30,000 rows in the middle, the shape of a server-side page render. Arms Z, Y and X
write 30 blobs of 150 KiB (about 4.5 MB) and 300 small rows.

| Arm | Alarm call                                    | Awaited fetch | Question                                   |
| --- | --------------------------------------------- | ------------- | ------------------------------------------ |
| A   | none                                          | no            | baseline                                   |
| B   | `setAlarm(+1 ms)` mid-event, not awaited      | no            | earlier alarm, fire and forget             |
| C   | `await setAlarm(+1 ms)` before the CPU        | no            | earlier alarm settled first                |
| D   | `await setAlarm(+1 ms)` after the CPU         | no            | earlier alarm at the end                   |
| G   | none                                          | mid-event     | does an outbound fetch alone reset         |
| H   | none                                          | no            | control for G, I                           |
| I   | none                                          | first         | fetch before the writes                    |
| J   | `+1 ms` mid-event, plus a heavy alarm handler | mid-event     | earlier alarm, then a fetch, with a firing |
| K   | heavy alarm handler, `+1 ms` after the fetch  | mid-event     | alarm set after the await                  |
| L   | `+1 ms` mid-event                             | no            | earlier alarm with no await                |
| M   | `+60 s` mid-event                             | no            | later alarm                                |
| N   | `+1 ms` mid-event                             | mid-event     | earlier alarm, then an awaited fetch       |
| O   | `+60 s` mid-event                             | mid-event     | later alarm, then an awaited fetch         |
| P   | `+1 ms` after the last write                  | mid-event     | alarm armed at the end of the event        |
| R   | `await sync()`, then `+1 ms`                  | mid-event     | the isolated move                          |
| Z   | none; 4.5 MB of blob writes in one event      | no            | one large commit                           |
| Y   | as Z, `sync()` every ten blobs                | no            | the same commit split                      |
| X   | as Z, one awaited fetch in the middle         | mid-event     | the same commit with a yield               |

### Micro-Ladder Arms

Each request runs `n` iterations inside one object (`?do=NAME&micro=ARM&n=N`). Every iteration
first moves the standing alarm ten minutes ahead and syncs, then runs the arm's operation. The
alarm handler of a micro object skips the default body, which writes a log row.

| Arm | Operation per iteration                                                                       | Question                          |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------- |
| A   | insert, `sync()`, `setAlarm(+1 ms)`, `sync()`                                                 | standalone earlier move           |
| B   | `setAlarm(+1 ms)` not awaited, insert, `sync()`                                               | earlier move merged into a commit |
| C   | insert, `await setAlarm(+20 min)`, `sync()`                                                   | later move                        |
| D   | as B, then `scheduler.wait(30)`; the alarm handler inserts, syncs and sets the standing alarm | earlier move that fires a handler |
| E   | insert, `sync()`                                                                              | control with no alarm call        |

A failure is an exception in an iteration or in the D handler. The driver counts client-side
failures separately: a non-200 reply, a fetch error, an `ok: false` reply, or a reply that contains
the platform text outside the `errors` list.

### Running the Micro Ladder

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
npx wrangler deploy --config experiments/alarm-discipline/wrangler.jsonc
export WORKER_URL=https://folio-alarm-discipline.example.workers.dev
ARMS=A,B,C,D,E OBJECTS=4 BATCHES=5 BATCH=100 node experiments/alarm-discipline/micro.ts
npx wrangler delete --config experiments/alarm-discipline/wrangler.jsonc
```

Each arm at the defaults runs 2,000 iterations. The driver writes the per-arm totals to
`runs/micro-<time>.json`. Inserts are counted by the object; the writes that alarm calls and syncs
make are not, so the platform's usage metrics are the only source for those.

## Running the bare arms

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
npx wrangler deploy --config experiments/alarm-discipline/wrangler.jsonc
export WORKER_URL=https://folio-alarm-discipline.example.workers.dev
ARMS=J,N,L,M,P,R N=40 ITERS=4e9 node experiments/alarm-discipline/bare.ts
ARMS=Z,Y,X N=60 ITERS=4e9 node experiments/alarm-discipline/bare.ts
npx wrangler delete --config experiments/alarm-discipline/wrangler.jsonc
```

`bare.ts` prints one line per arm and writes `runs/bare-<time>.json`, which is git-ignored. A run
costs rows on the account: an arm at `N=40` writes about 80,000 rows, so price the arm list before
running it and delete the worker afterwards.

## Running the deployed A/B

The A/B needs a Drupal site on Durable Objects whose object follows this contract:

- A request carrying `x-alarm-mode: legacy` moves the alarm earlier inside the event, so the alarm
  call merges into the event's own commit.
- A request without the header commits the event with `storage.sync()` before moving the alarm
  earlier, so the move is a commit of its own.
- Every response carries `x-alarm-mode` (`legacy` or `isolated`), `x-earlier-moves` (how many times
  that request moved the stored alarm earlier) and `x-isolated-moves` (how many of those followed a
  `sync()`).

`ACCESS_FILE` holds `{ "cookie": "..." }` for a logged-in administrator on that site.

```sh
npx wrangler tail $SITE_NAME --format json > tail.json &
export WORKER_URL=https://$SITE_NAME.example.workers.dev ACCESS_FILE=access.json
BLOCKS=50 node experiments/alarm-discipline/ab.ts
node experiments/alarm-discipline/analyze.ts experiments/alarm-discipline/runs/ab-TIME.jsonl tail.json
```

The driver alternates the arms by block. Each block clears the caches and then visits the
performance, status, modules, content and performance pages, so every page after the clear renders
cold. `analyze.ts` credits each platform failure event to at most one request: the latest one that
started no later than the event and whose window, 500 ms before its start to 3 s after its end,
holds it. Failures outside every window, such as an install, are counted apart. Delete the site
afterwards and compare the account's resources with what they were before.

## Results

### Micro-Ladder Results

One deployment, 2026-11-21. Each arm ran on four objects, five batches of 100 iterations per
object, one arm per run.

| Arm | Iterations |  Done | In-object failures | Client errors | Resets | Failure rate (95% Wilson) | Inserts |
| --- | ---------: | ----: | -----------------: | ------------: | -----: | ------------------------- | ------: |
| A   |      2,000 | 2,000 |                  0 |             0 |      0 | 0.00% (0.00% to 0.19%)    |   2,000 |
| B   |      2,000 | 2,000 |                  0 |             0 |      0 | 0.00% (0.00% to 0.19%)    |   2,000 |
| C   |      2,000 | 2,000 |                  0 |             0 |      0 | 0.00% (0.00% to 0.19%)    |   2,000 |
| D   |      2,000 | 2,000 |                  0 |             0 |      0 | 0.00% (0.00% to 0.19%)    |   4,000 |
| E   |      2,000 | 2,000 |                  0 |             0 |      0 | 0.00% (0.00% to 0.19%)    |   2,000 |

Arm D ran its handler on all 2,000 iterations, with no handler failures. The D insert count includes
the handler's row.

No arm reset, and no arm produced an in-object or client-side failure, in 10,000 iterations. The
intervals bound the failure rate of each arm; the upper bound is 0.19% for every arm.

What this does not show:

- The failure path was not exercised. Zero failures show that the runs completed, not that the
  driver would count a failure; no positive control was run.
- The object has no PHP and no Drupal. The isolated arm of the deployed A/B reset on 10 of 66
  requests that made an isolated move; these arms did not reproduce that rate.
- Alarm and sync writes are not in the insert counts, so the rows written per iteration are not
  measured here.

### Bare arms

Eight runs, each arm on a fresh object, 2026-11-21. A reset counts only the platform text
"Internal error in Durable Object storage". CPU-limit resets and "reset because its code was updated"
(a redeploy during a run) are listed apart and are not storage resets.

| Run | Iterations | Arms: storage resets / requests                                        | Other failures                                        |
| --- | ---------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| 1   | 3e9        | A 0/25, B 0/25, C 0/25, D 0/25 (median 6.0 s)                          | none                                                  |
| 2   | 1e9        | G 0/30                                                                 | the loop was optimized away; CPU was too low to count |
| 3   | 8e9        | G 0/30, H 0/30, I 0/30                                                 | 17 CPU-limit resets (G 9, H 1, I 7), so run 3 is void |
| 4   | 4e9        | J 1/30, K 0/30, H 0/30                                                 | K 1 code-updated                                      |
| 5   | 4e9        | L 0/30, M 0/30, N 1/30, J 1/30                                         | none                                                  |
| 6   | 4e9        | O 0/12, P 0/12, R 0/12, N 1/12                                         | O, P, R 1 code-updated each                           |
| 7   | 4e9        | N 1/40, P 0/40                                                         | P 1 code-updated                                      |
| 8   | 4e9        | Z 0/60 and 0/60 (two passes, median 20.7 s and 19.1 s), Y 0/60, X 0/60 | Y, X 1 code-updated each                              |

Arms that set an alarm `+1 ms` before an awaited fetch (J and N): 5 storage resets in 142 requests.
The other alarm-bearing arms with 4e9 iterations (K, L, M, O, P, R): 0 in 166. If the five resets
were spread over the 308 requests at random, all five landing in the first group has probability
about 0.02 (hypergeometric). The result is suggestive, not conclusive, and the rate in the first
group is 3.5%.

What the bare arms do not show:

- A large single commit alone does not reset. Z writes about 4.5 MB in one event with no yield and
  never resets, but the commit takes about 17 s, so a long synchronous event is slow before it fails.
- Splitting the commit (Y) or yielding with a fetch (X) did not change the outcome either way.
- Setting the alarm later (M, O) or at the end of the event (P) or after a `sync()` (R) did not reset
  in 12 to 60 requests each. Those counts are too small to call R and P safe.

### Deployed A/B

One deployed site, 2026-11-21. Fifty blocks alternated between the legacy path and
the isolated move, 300 requests, 150 per arm, every one answered. The isolated arm commits the event
with `storage.sync()` before an alarm moves earlier, so the move travels in a commit of its own.

| Arm      | Requests | Earlier moves | Isolated moves | Storage resets | Memory resets | Median ms |
| -------- | -------: | ------------: | -------------: | -------------: | ------------: | --------: |
| legacy   |      150 |            72 |              0 |              1 |             9 |     6,747 |
| isolated |      150 |            71 |             66 |             11 |             6 |     7,402 |

Storage resets differ (Fisher exact p = 0.005), in the direction opposite to the one the isolated
move predicts. Memory resets do not differ (p = 0.6). Ten of the 11 resets in the isolated arm came
on a request that made an isolated move (10 of 66, 15%). The legacy arm made 72 earlier moves with no
reset on any of them; its one reset came on a status page that moved no alarm. Resets by page,
legacy then isolated: performance 0 and 6, status 1 and 1, modules 0 and 1, content 0 and 1, cache
clear 0 and 2.

What this shows and does not show:

- Moving the alarm earlier inside an event did not reset this object (0 of 72). The alarm-manager
  call is not what fails on these requests at a rate the arm can see.
- Committing first with `sync()` raised the reset rate, so it is not a fix.
- Only the commit-first design ran. A design where request paths never move the alarm earlier and
  leave the drain to the standing tick was not an arm.
- The legacy arm reset on 1 of 150 requests, so a change that removes resets cannot show a
  difference at this count.

## Overlap

Does an alarm that falls due during a long synchronous event reset the object, and does yielding
inside the event change the result? `overlap-worker.mjs` holds the `Overlap` object, and `overlap.ts`
drives it.

### Arms

Each counted event sets a standing alarm ten minutes out and commits it, then runs one arm. The busy
loop is count-based: `burn(n)` runs `n` iterations, and `cpu=MS` maps to `MS * 1.3e6` iterations.
The default `cpu=1000` took 6.3 to 6.8 seconds per event on the deployed Worker, except the sliced
arm (see Limits). The loop reads no clock.

| Arm                         | Alarm                                        | Busy loop                                  |
| --------------------------- | -------------------------------------------- | ------------------------------------------ |
| `no-alarm`                  | none                                         | one loop                                   |
| `alarm-2s-committed`        | due in 2 s, committed before the loop        | one loop                                   |
| `alarm-1ms-unawaited`       | due in 1 ms, not awaited                     | one loop                                   |
| `alarm-20min-committed`     | due in 20 minutes, committed before the loop | one loop                                   |
| `alarm-2s-committed-sliced` | due in 2 s, committed before the loop        | five slices with a 50 ms wait between them |
| `X`                         | none                                         | positive control, see below                |

`X` aborts the object on the second event of an instance, so it checks that the driver counts a
failure and an instance change.

Each event's reply carries `fires`, the handler runs since the previous reply, and `atStart`, the part
of that count that ran before the request began. The driver sets an event's `firesAfterEnd` from the
next request's `atStart`, and its `firesInEvent` is `fires - atStart`. A trailing request, arm `T`,
runs 3 seconds after each object's last event, so the final fires are counted.

Each object gets one warm-up event before its counted events. The warm-up is not in the event total.

### Running

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
npx wrangler deploy --config experiments/alarm-discipline/wrangler.overlap.jsonc
export WORKER_URL=https://folio-alarm-overlap.example.workers.dev
ARMS=no-alarm,alarm-1ms-unawaited OBJECTS=3 EVENTS=20 node experiments/alarm-discipline/overlap.ts
npx wrangler delete --config experiments/alarm-discipline/wrangler.overlap.jsonc
```

`ARMS` takes a comma list of the arm names above. `OBJECTS` and `EVENTS` set the counted events per
arm (defaults 3 and 20). `CPU` sets the burn, and `GAP` and `TRAIL_GAP` set the waits in
milliseconds. The driver writes one record per request to `runs/overlap-<time>.json`. The first-event
arms run in the same driver; see First Event.

### Results

One deployed run with the defaults: 3 objects, 20 counted events each, so 60 counted events per arm.
The storage rate is storage resets over counted events, with a Wilson 95% interval.

| Arm                         | Storage resets | Storage rate (95% Wilson) | Fires during event | Fires after event | Median wall |
| --------------------------- | -------------: | ------------------------- | -----------------: | ----------------: | ----------: |
| `no-alarm`                  |              0 | 0.00% (0.00% to 6.02%)    |                  0 |                 0 |       6.3 s |
| `alarm-2s-committed`        |              0 | 0.00% (0.00% to 6.02%)    |                  0 |                60 |       6.8 s |
| `alarm-1ms-unawaited`       |              0 | 0.00% (0.00% to 6.02%)    |                  0 |                60 |       6.6 s |
| `alarm-20min-committed`     |              0 | 0.00% (0.00% to 6.02%)    |                  0 |                 0 |       6.5 s |
| `alarm-2s-committed-sliced` |              0 | 0.00% (0.00% to 6.02%)    |                  3 |                58 |       1.2 s |

With the warm-up counted, `alarm-1ms-unawaited` had 3 storage resets in 63 events (4.76%, 1.63% to
13.09%). All three were warm-up events on fresh objects. The other arms had none.

The run does not answer the question. No counted event reset in any arm. In `alarm-2s-committed` and
`alarm-1ms-unawaited`, every counted alarm ran after its event: 60 of 60 landed after the event, and
none during it.

### Limits

- The sliced arm's loop took 1.2 s median, about a fifth of the other arms' time. Its burn was too
  short to test the slice boundaries, so its row says nothing about them.
- 60 counted events per arm bound a rate of zero only below 6.02%.
- The warm-up events held all three storage resets. The cause is not known, and the run does not
  attribute it to the alarm.

## First Event

On a deployed Durable Object, the first event on a new object can fail with a storage reset when that
event sets an alarm and then runs a busy loop of about 1.5 seconds. These arms run that first event
on fresh objects, one object per sample, and vary the alarm call, the loop length and the order of
the commit. The mechanism is not established by these runs.

### Arms

| Arm                               | First event                                                               |
| --------------------------------- | ------------------------------------------------------------------------- |
| `burn-then-write`                 | 1.5 s loop, one row, no alarm (control)                                   |
| `alarm-unawaited-then-burn`       | alarm due in 1 ms, not awaited, then the 1.5 s loop and one row           |
| `alarm-awaited-then-burn`         | alarm due in 1 ms, awaited but not synced, then the loop and one row      |
| `alarm-unawaited-short-burn`      | as `alarm-unawaited-then-burn`, with a 0.3 s loop                         |
| `alarm-unawaited-long-burn`       | as `alarm-unawaited-then-burn`, with a 3 s loop                           |
| `alarm-20min-unawaited-then-burn` | alarm due in 20 minutes, not awaited, then the loop and one row           |
| `alarm-unawaited-no-burn`         | alarm due in 1 ms, not awaited, one row, no loop                          |
| `prior-burn-then-alarm-unawaited` | a 1.3 s throwaway event first, then the `alarm-unawaited-then-burn` shape |
| `alarm-awaited-synced-then-burn`  | alarm due in 1 ms, awaited and synced, then the loop and one row          |
| `burn-then-alarm-unawaited`       | the loop, then alarm due in 1 ms, not awaited, then one row               |

The driver sends the throwaway for `prior-burn-then-alarm-unawaited` before the counted event.

### Ordering Arms

These arms order the alarm call and the commit around the loop. The ordering run also used
`burn-then-write` (control) and `burn-then-alarm-unawaited` from the table above.

| Arm                                     | Order                                                   |
| --------------------------------------- | ------------------------------------------------------- |
| `burn-then-alarm-awaited-sync`          | loop, alarm due in 1 ms awaited, sync, one row          |
| `burn-then-alarm-unawaited-sync`        | loop, alarm due in 1 ms not awaited, sync; no row       |
| `burn-then-alarm-unawaited-wait`        | loop, alarm due in 1 ms not awaited, 50 ms wait; no row |
| `write-sync-then-burn-alarm-unawaited`  | one row, sync, loop, alarm due in 1 ms not awaited      |
| `burn-then-alarm-awaited-wait`          | loop, alarm due in 1 ms awaited, 50 ms wait; no row     |
| `burn-write-then-alarm-20min-unawaited` | loop, one row, alarm due in 20 minutes not awaited      |

### Running

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
npx wrangler deploy --config experiments/alarm-discipline/wrangler.overlap.jsonc
export WORKER_URL=https://folio-alarm-overlap.example.workers.dev
ARMS=burn-then-write,alarm-unawaited-then-burn SAMPLES=20 node experiments/alarm-discipline/overlap.ts
npx wrangler delete --config experiments/alarm-discipline/wrangler.overlap.jsonc
```

Each sample sends a probe that reads the instance id without touching storage, then the counted first
event, then a trailing probe 3 seconds later. `SAMPLES` sets the samples per arm (default 20). The
driver writes one record per sample to `runs/first-<time>.json`.

### Results

Rates are storage resets over first-event samples, with a Wilson 95% interval. Each arm ran 20
samples.

| Arm                               | Storage resets | Rate (95% Wilson)         |
| --------------------------------- | -------------: | ------------------------- |
| `burn-then-write`                 |              0 | 0.00% (0.00% to 16.11%)   |
| `alarm-unawaited-then-burn`       |             19 | 95.00% (76.39% to 99.11%) |
| `alarm-awaited-then-burn`         |             19 | 95.00% (76.39% to 99.11%) |
| `alarm-unawaited-short-burn`      |              0 | 0.00% (0.00% to 16.11%)   |
| `alarm-unawaited-long-burn`       |             18 | 90.00% (69.90% to 97.21%) |
| `alarm-20min-unawaited-then-burn` |              0 | 0.00% (0.00% to 16.11%)   |
| `alarm-unawaited-no-burn`         |              0 | 0.00% (0.00% to 16.11%)   |
| `prior-burn-then-alarm-unawaited` |              0 | 0.00% (0.00% to 16.11%)   |
| `alarm-awaited-synced-then-burn`  |              0 | 0.00% (0.00% to 16.11%)   |
| `burn-then-alarm-unawaited`       |             15 | 75.00% (53.13% to 88.81%) |

The reset text was `Internal error in Durable Object storage caused object to be reset`, with a
reference id that changes per sample. In the control arm, the trailing probe saw a new instance after
an ok first event in 20 of 20 samples.

What the pairs show. These are necessary conditions from the arm pairs, not a mechanism.

- Loop length: the 0.3 s and no-loop arms did not reset. The 1.5 s and 3 s arms did. The threshold lies
  between 0.3 s and 1.5 s.
- Alarm distance: the 20-minute alarm did not reset. The 1 ms alarm did.
- Sync before the loop: `alarm-awaited-synced-then-burn` did not reset. Its alarm fired at its sync,
  before the loop, in all 20 samples. `alarm-awaited-then-burn`, which did not sync, reset in 19 of 20.
- Throwaway first: `prior-burn-then-alarm-unawaited` did not reset. Its throwaway replaced the object
  in 16 of 20 samples. The other 4 counted events ran on the original instance.
- Burn first: `burn-then-alarm-unawaited` reset in 15 of 20, so burning first does not avoid the reset.

Ordering results. The last two rows are the control and the burn-first shape, run again in the
ordering run.

| Arm                                        | Storage resets | Rate (95% Wilson)           |
| ------------------------------------------ | -------------: | --------------------------- |
| `burn-then-alarm-awaited-sync`             |             20 | 100.00% (83.89% to 100.00%) |
| `burn-then-alarm-unawaited-sync`           |             19 | 95.00% (76.39% to 99.11%)   |
| `burn-then-alarm-unawaited-wait`           |             17 | 85.00% (63.96% to 94.76%)   |
| `write-sync-then-burn-alarm-unawaited`     |             14 | 70.00% (48.10% to 85.45%)   |
| `burn-then-alarm-awaited-wait`             |             15 | 75.00% (53.13% to 88.81%)   |
| `burn-write-then-alarm-20min-unawaited`    |              0 | 0.00% (0.00% to 16.11%)     |
| `burn-then-write` (ordering run)           |              0 | 0.00% (0.00% to 16.11%)     |
| `burn-then-alarm-unawaited` (ordering run) |             14 | 70.00% (48.10% to 85.45%)   |

Only the 20-minute alarm fell to the control level. Every arm that set a near-due alarm after the loop
reset in 14 to 20 of 20 samples, including `burn-then-alarm-awaited-sync`. No arm here tests a
near-due alarm moved to the end of a heavy event and avoids the reset.

### Limits

- Wilson intervals at 20 samples are wide. Zero of 20 bounds the rate only below 16.11%.
- Three ordering arms insert no row (`burn-then-alarm-unawaited-sync`, `burn-then-alarm-unawaited-wait`
  and `burn-then-alarm-awaited-wait`). Their rates are not directly comparable with the arms that do.
- The control and `burn-then-alarm-unawaited` each ran in two runs, the first-event run and the
  ordering run, and their counts are reported per run.
- `burn-write-then-alarm-20min-unawaited` tests a far alarm. The deployed A/B moves the alarm earlier
  inside the event, a case no arm here covers.

## Bisect

Which feature of a bare event makes a SQLite Durable Object fail? `bisect-worker.mjs` holds the
`Bisect` object, and `bisect.ts` drives it. Every arm runs the same base event: 2,000
`INSERT OR REPLACE` writes into `w`, a read of 10,000 rows from `big` in the middle of the event, a
synchronous burn loop, and one 0.6 MB JSON row into `jl`. `SYNC=1` adds `await storage.sync()` at the
end of the event.

### Arms

| Arm                | Added to the base event                                                                  |
| ------------------ | ---------------------------------------------------------------------------------------- |
| `control`          | nothing                                                                                  |
| `pad-table`        | a 100 MiB `pad` table of 100 blob rows, filled on the object's first event               |
| `large-json-rows`  | two more `jl` rows of 1.5 MB and 1.75 MB                                                 |
| `ballast-memory`   | 100 MiB of `WebAssembly.Memory` and a 30 MiB string kept alive by the object             |
| `fingerprint-pass` | a pass at the end of the event that reads every row of `big` and `w` and hashes it in JS |
| `all-features`     | `pad-table`, `large-json-rows`, `ballast-memory` and `fingerprint-pass` together         |

### Running

```sh
export CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=...
npx wrangler deploy --config experiments/alarm-discipline/wrangler.bisect.jsonc
export WORKER_URL=https://folio-alarm-bisect.example.workers.dev
ARM=control N=120 OBJECTS=3 PREFIX=run1 ITERS=6.5e9 node experiments/alarm-discipline/bisect.ts
npx wrangler delete --config experiments/alarm-discipline/wrangler.bisect.jsonc
```

- `ARM` picks the arm. `PREFIX` names the objects, so each arm needs its own.
- `ITERS` sets the burn loop length. The worker default is 4e9.
- `PREPLACE=1` sends one throwaway event with `PREPLACE_ITERS` (default 2.1e9) to each object, then
  reads the instance id with a `stat` request before the counted events.
- `CAP_ROWS` stops the arm before its estimated row writes would exceed the cap.

Output goes to `runs/bisect-<prefix>-<time>.json`. Each counted event is recorded as
`{ i, obj, idx, inst, instChanged, cls, text, clientMs }`. `cls` is one of `ok`,
`storage_generic` (`Internal error in Durable Object storage`), `storage_timeout`
(`storage operation exceeded timeout`), `cpu_limit` (`CPU time limit`), `memory` (`memory limit`) or
`other`.

### Results

First run: 30 events per arm (2 objects, 15 events each), `SYNC=0`, `ITERS=6.5e9`. The driver's
classifier missed the storage timeout text in this run, so these counts come from the JSON.

| Arm                |  ok | Storage timeouts |  Rate |
| ------------------ | --: | ---------------: | ----: |
| `control`          |  28 |                2 |  6.7% |
| `pad-table`        |  28 |                2 |  6.7% |
| `large-json-rows`  |  24 |                6 | 20.0% |
| `ballast-memory`   |  28 |                2 |  6.7% |
| `fingerprint-pass` |  27 |                3 | 10.0% |
| `all-features`     |  28 |                2 |  6.7% |

The control is above the 3% threshold, so this run does not isolate a feature. The `SYNC=1` split for
`all-features` is not recorded; its failures were not split by class.

Control runs with 120 events each, 3 objects, one run per row:

| Run | ITERS | Pre-placed |  ok | Storage timeouts | CPU limit | Non-ok rate (95% Wilson) |
| --- | ----: | ---------- | --: | ---------------: | --------: | ------------------------ |
| 1   | 6.5e9 | no         |  62 |               16 |        42 | 48.3% (39.6% to 57.2%)   |
| 2   | 6.5e9 | yes        |  54 |                7 |        59 | 55.0% (46.1% to 63.6%)   |
| 3   |   4e9 | no         | 120 |                0 |         0 | 0.0% (0.0% to 3.1%)      |

The control failed at about 7% in the 30-event run and at 48% and 55% in the 120-event runs at
`ITERS=6.5e9`. The gap is not explained. At `ITERS=4e9`, the 120-event run had no failures. A reset
takes about 31 seconds of client time before the error reply arrives.

### Limits

- The first run used an earlier key scheme for `jl` (`seq * 4`) that collided after a reset. Its
  `jl` counts are not write counts. The collision does not change the reset counts.
- The handler's own timer read 0 ms in every `SYNC=0` arm. The object's clock advanced at syncs and
  not during the synchronous burn, so use `medianClientMs` for timing.

## Limits

The bare object has no PHP and no Drupal. It reproduces the commit shape, and the deployed A/B covers
the site. The deployed
A/B drives only admin pages after cache clears, from one client, against one object. A reset the tail
does not report is not counted. The platform text does not name the failing call.
