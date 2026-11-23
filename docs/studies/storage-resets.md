# Storage Resets

A Durable Object that writes to its SQLite storage can fail with "Internal error in Durable Object storage ... caused object to be reset". This page covers the experiments that looked for what triggers the reset on a Drupal site running on Durable Objects, which alarm shapes avoid it, and what the fix reaches.

## Question

Which request and alarm shapes turn a healthy object into a storage reset, and does any change to those shapes remove the resets on a deployed site?

## Instruments

| Instrument                                                                                                | Object under test                      | Plan |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------- | ---- |
| [alarm-discipline](https://github.com/gmitch215/folio/blob/master/experiments/alarm-discipline/README.md) | bare SQLite object and a deployed site | paid |
| [alarm-retirement](https://github.com/gmitch215/folio/blob/master/experiments/alarm-retirement/README.md) | bare SQLite object                     | paid |
| [commit-ladder](https://github.com/gmitch215/folio/blob/master/experiments/commit-ladder/README.md)       | bare SQLite object                     | paid |
| [idle-floor](https://github.com/gmitch215/folio/blob/master/experiments/idle-floor/README.md)             | bare SQLite object                     | paid |

The deployed A/B and the 5 s floor runs used one Drupal site, alternating arms by request header and clearing the caches between blocks. Their per-request rows are not exported to `results/`, so those figures come from [the report](../../TECHNICAL_REPORT.md#storage-resets-and-the-growth-governor).

## Where the Resets Fall

The first look was a count over the tails of five drives of the site and one fresh fixture. 464 requests used more than 300 ms of CPU.

| Condition                                            | Reset requests |
| ---------------------------------------------------- | -------------- |
| An alarm handler overlapped the request              | 1 of 319       |
| No alarm handler overlapped the request              | 25 of 145      |
| A second sample, with an overlapping alarm           | 1 of 361       |
| A second sample, without an overlapping alarm        | 3 of 69        |
| Heavy requests that never waited on I/O for a second | 22 of 220      |
| Heavy requests that waited on I/O for a full second  | 0 of 56        |

The page mattered less than the shape: status 14 of 93, modules 6 of 48, performance 3 of 65 and content 0 of 33. These drives were not designed as experiments, so the counts locate the failures without isolating a cause.

## Bare Object Arms

The platform's SQLite actor takes a synchronous alarm-manager call before a commit that moves the alarm earlier. A failure there would break the output gate for every write in the commit, so an alarm set 1 ms ahead on every render was the leading suspect.

| Arm                                                                                                  | Result                  |
| ---------------------------------------------------------------------------------------------------- | ----------------------- |
| `setAlarm(+1 ms)` before an awaited fetch, 2,000 small rows and a 30,000-row read, 4 s to 6 s of CPU | 5 of 142 requests reset |
| Every other alarm-bearing arm                                                                        | 0 of 166                |
| A single commit of 4.5 MB                                                                            | 0 of 120                |
| The same commit with `sync()` every ten blobs                                                        | 0 of 60                 |
| The same commit with an awaited fetch in the middle                                                  | 0 of 60                 |

The difference between 5 of 142 and 0 of 166 has a hypergeometric p of about 0.02 and a rate of 3.5% (eight runs, [alarm-discipline](https://github.com/gmitch215/folio/blob/master/experiments/alarm-discipline/README.md)).

## Deployed A/B

The treatment commits the event with `storage.sync()` before an alarm moves earlier, so the move travels in a commit of its own. Fifty blocks alternated the treatment with the old path by request header, 150 requests per arm, on one deployed site.

| Arm          | Storage resets | Memory resets |
| ------------ | -------------- | ------------- |
| Old path     | 1 of 150       | 9             |
| Commit first | 11 of 150      | 6             |

Fisher's exact test gives p = 0.005 for the storage resets and p = 0.6 for the memory resets. The old path made 72 earlier alarm moves and none of them reset. Ten of the treatment's 11 resets came on requests that made an isolated move, 10 of 66. An earlier alarm move did not reset this object, and committing first made resets more frequent. The site ran a frozen copy of the application without the request-only PHP reuse of the earlier drives, so its baseline rate differs from theirs.

## Retirement and Alarm Shape

On a bare object the platform retires an isolate near event 20 to 23 of a chain, silently when no alarm is pending. With an alarm due within about a second at that boundary, every retirement was a storage reset. Each cell is 20 objects or chains, with a nominal 0.25 s of CPU per chain event.

| Arm (first event of a fresh object) | Reset rate |
| ----------------------------------- | ---------- |
| No alarm                            | 0 of 20    |
| Alarm 1 ms ahead                    | 14 of 20   |
| Alarm 10 ms ahead                   | 13 of 20   |
| Alarm 100 ms ahead                  | 14 of 20   |
| Alarm 1 s ahead                     | 16 of 20   |
| Alarm 5 s ahead                     | 0 of 20    |
| Alarm 60 s ahead                    | 0 of 20    |

| Arm (chains of up to 24 events)                     | Chains with a reset |
| --------------------------------------------------- | ------------------- |
| No alarm                                            | 0 of 20             |
| Start of event, alarm moved to 1 ms, awaited        | 9 of 20             |
| Start of event, alarm moved to 1 ms, unawaited      | 6 of 20             |
| Start of event, no row writes                       | 10 of 20            |
| Start of event, alarm moved to 5 s                  | 0 of 20             |
| End of event, `sync()` then alarm at 1 ms           | 0 of 20             |
| End of event, alarm at 1 ms, awaited, then `sync()` | 9 of 20             |
| End of event, alarm at 1 ms, unawaited              | 6 of 20             |
| End of event, alarm at 1 ms, events back to back    | 11 of 20            |
| End of event, alarm at 60 s                         | 0 of 20             |

In the arms that reset, every retirement was a reset, except one arm that read 0.90 resets per retirement (an awaited alarm move followed by `sync()`). A `sync()` at the end of the start shape did not avoid it (9 of 20), and a burn-only event with the same alarm move reset as often (10 of 20), so unsynced writes are not required. The count of chains that retire within 24 events varies from run to run. All of these are bare objects, nominal CPU, and no mechanism is shown ([alarm-retirement](https://github.com/gmitch215/folio/blob/master/experiments/alarm-retirement/README.md)).

## The Idle Floor and the Commit Ladder

The idle-floor experiment sets a floor under the background failure rate of ordinary small commits. Ten idle objects woke every 3 minutes for four hours, each alarm run inserting a row, syncing, inserting a second row and syncing.

| Measure                              | Value |
| ------------------------------------ | ----- |
| Alarm runs begun                     | 800   |
| Runs completed                       | 800   |
| Failed runs                          | 0     |
| Instance changes beyond the first    | 790   |
| Upper bound on the failure rate, 95% | 0.48% |

The commit ladder wrote events of increasing size to fresh objects, six counted events per cell. Commits of up to 40,000 rows or 32 MiB showed no storage reset, memory limit, CPU limit or timeout, which leaves a reset rate of up to 39% possible at this sample size. Rows at 100,000 per commit were not measured. In the blocked cells, the first two events per object took 3.9 s to 5.2 s and later events 0.7 s to 1.2 s ([idle-floor](https://github.com/gmitch215/folio/blob/master/experiments/idle-floor/README.md), [commit-ladder](https://github.com/gmitch215/folio/blob/master/experiments/commit-ladder/README.md)).

## The 5 s Alarm Floor

The site now moves its alarm at least 5 s ahead on every request path. Three deployed runs sent 300 requests per arm, in blocks that clear the caches and then visit the performance, status, modules and content pages.

| Run                       | With the floor                                | Without the floor                  |
| ------------------------- | --------------------------------------------- | ---------------------------------- |
| First, header-alternated  | 0 of 300                                      | 47 of 300                          |
| Second, header-alternated | 1 of 300                                      | 34 of 300                          |
| Third, two sites          | 4 of 300                                      | 33 of 300                          |
| Pooled                    | 5 of 900 (0.56%, 95% interval 0.24% to 1.29%) | 114 of 900 (12.7%, 10.7% to 15.0%) |

A 2 s floor read 7 of 300 in an earlier run. The third run's one-sided Fisher test gives p = 2.6e-7 by request and 6.6e-4 by block. Its pre-set gate of at most 2 of 300 was not met, and three of the four resets fell in the first 8 of 50 blocks after a fresh install. The per-request rows are not exported.

The remainder is not the alarm that the request itself arms coming due near the request's end. In the run that recorded each request's alarm move, the floor read 1 of 300. None of its 85 requests that moved the alarm reset, and the one reset was a request that made no move. Without the floor in the same run, 24 of 190 movers (12.6%) and 10 of 110 non-movers (9.1%) reset, which the run cannot separate (Fisher two-sided p = 0.45). A non-mover can still run while an alarm set by an earlier request or a firing comes due, and the header does not record that.

## CPU as a Candidate

CPU use is the candidate that remains. A recount of the tail records of two header-alternated runs on the deployed site, split by the object CPU of each request, reads 9 of 426 requests at 4 s of CPU or more resetting, against 2 of 1,072 below 4 s. Bare Durable Objects were run to isolate it, with 8 resets of 15 at the heaviest setting and none for idle requests.

| Arm                                                                                                      | Result                                                                 |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Idle request of 2, 4 or 8 s of wall time, alarm armed at its start 1, 5, 10 or 15 s ahead, fresh objects | 0 resets in 120 objects                                                |
| The same, warm chains of 24 events                                                                       | none of 45 chains reset or retired (1,080 events)                      |
| CPU burned in slices with a timer between them, no alarm, 10 fresh objects per cell                      | 0, 0, 0, 2, 0 and 5 of 10 at 0, 0.25, 0.5, 1, 2 and 4 s of nominal CPU |
| The same with a 15 s alarm armed, 5 objects per cell                                                     | 3 of 5 at the heaviest setting and none below it                       |
| Five chains of six requests at 1 s nominal CPU, no alarm                                                 | 5 resets in 30 events, once per chain, each followed by a new isolate  |

An idle request cannot reproduce the reset. In the cells where the alarm was set 1 s ahead it came due inside the request, and the request still returned. A request that burns CPU resets at its first storage write after the loop (`Durable Object reset because its code was updated`), with no alarm armed as well as with one. A nominal slice cost about 60 ms of measured CPU, so the heaviest setting is about 1 s of object CPU. The pre-set prediction, a knee between 0.5 and 2 s of nominal CPU, was refuted as stated: 2 s gave 0 of 15.

Post hoc, the heaviest setting splits on measured CPU: all 8 requests at 1,038 ms or more reset and the 7 below 1,000 ms did not. That reading was made after the outcome and is not a test of a prediction. One reset at 1 s nominal had measured CPU of 128 ms and does not fit, and the two groups overlap in measured CPU, so no clean threshold shows.

The storage-yield arm and the alarm-cadence arm did not run: the clock did not advance over storage awaits, so the smoke check failed. Whether the timer yield, and not the CPU, is what resets a bare object is open. The bare-object rate for a heavy request (about 1 of 2) is far above the site's per-long-event rate (about 2 percent), so CPU is necessary and not sufficient. The rows are in [idle-requests](https://github.com/gmitch215/folio/blob/master/results/continuation/idle-requests/README.md) and [cpu-bare-objects](https://github.com/gmitch215/folio/blob/master/results/continuation/cpu-bare-objects/README.md).

## What a Reset Commits

A bare Durable Object event wrote a marker row `m` and a row `y`, awaited 50 ms, then wrote a row `x` and, in a separate transaction, a row `z`, and a reset killed the event. A fresh stub read the rows back, and a second read 3 s later agreed in every trial. With n = 10 per cell:

| Kind and variant                                | Rows kept           | Reading                        |
| ----------------------------------------------- | ------------------- | ------------------------------ |
| Memory reset, memory held before the yield      | `m`, `y` (10 of 10) | `x` and `z` lost               |
| Memory reset, memory held after the last write  | all four (10 of 10) | nothing lost                   |
| CPU kill, burn between the writes and the yield | none (10 of 10)     | `m` and `y` lost with the rest |
| CPU kill, burn after the last write             | `m`, `y` (10 of 10) | `x` and `z` lost               |

Read after the fact, each kind kept what was written before the last yield and lost what came after it. Two cases differ: the memory reset after the last write lost nothing, and a CPU kill with no yield since the writes lost all of them. The pre-set prediction that a CPU kill after all writes keeps nothing was refuted, because the two rows written before the yield survived.

Storage resets, pooled over the runs that produced the `Internal error in Durable Object storage` text, kept all rows in 23 events, none in 1 and a partial set in 0, against 105, 14 and 0 of 119 in the earlier read-back. The handler shape of this test, with a yield before the second write, produced 0 of 20 such resets. 18 of 20 chains stopped at the first storage write after the yield with `Durable Object reset because its code was updated`, with `m` and `y` kept in all 18. A supplementary arm without the yield gave the storage resets: 20 of 20 chains, all four rows in 19 and none in 1.

The first request after a reset took about 170 to 265 ms of client wall time, against about 40 to 60 ms for the next one on the same object, with at most 1 ms of CPU for either (the storage-reset CPU rests on 3 samples). No unreachable window was seen: 82 of 82 first reads succeeded at the first attempt. The rows are in [reset-commit](https://github.com/gmitch215/folio/blob/master/results/continuation/reset-commit/README.md).

A design that writes a marker before an effect may rely on this much: a marker followed by an awaited yield survived every reset kind here. A marker followed directly by the effect can be lost with the effect repeated. A separate arm tested the flush: after two plain writes, `await storage.sync()` and then a burn past the CPU limit kept both rows in 10 of 10 objects, against none of 10 with no flush, and a 50 ms yield after the flush changed nothing ([sync-commit](https://github.com/gmitch215/folio/blob/master/results/continuation/sync-commit/README.md)). A claim inside `transactionSync`, and memory or storage resets after a flush, are not measured.

## Reading

The 5 s floor fixes request-path storage resets to about 0.6%. Two designs that looked like the cause did not hold up: an earlier alarm move by itself (a move 5 s ahead did not reset a bare object) and committing before the move (it made resets more frequent). On a bare object, a commit followed by a near alarm at the end of an event did not reset in 20 chains, and a near alarm at an isolate boundary did.

## Closed and Open

Closed: alarm isolation by `sync()` as a fix on the deployed site, the earlier alarm move as the cause of admin page resets, and the request's own alarm coming due near its end as the cause of the resets that remain under the floor, and an idle request, with or without a near alarm, as a way to reproduce the reset on a bare object.

Open: the CPU candidate (a clean threshold, and whether the timer yield and not the CPU resets a bare object, since the storage-yield and alarm-cadence arms did not run), the cause of the remaining resets and of the generic storage reset, whether a longer floor reaches zero (300 requests per arm cannot tell a 5 s floor from a 15 s one), whether the retirement result holds on the deployed site, and whether request-only reuse changes the reset rate at the same drive. Retry safety after a reset is not covered here.

## See Also

- Report: [Storage Resets and the Growth Governor](../../TECHNICAL_REPORT.md#storage-resets-and-the-growth-governor)
- Module: [Continuation](../modules/continuation.md), which uses the same alarm discipline
- Related study: [Memory Accounting](memory-accounting.md) for the growth governor
