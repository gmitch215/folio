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

The tail counts above hint that long CPU use matters: heavy requests that never waited on I/O reset more often than those that did. No arm varies CPU alone on this site. CPU use is a candidate cause, with the tail counts as its only support in this repository.

## Reading

The 5 s floor fixes request-path storage resets to about 0.6%. Two designs that looked like the cause did not hold up: an earlier alarm move by itself (a move 5 s ahead did not reset a bare object) and committing before the move (it made resets more frequent). On a bare object, a commit followed by a near alarm at the end of an event did not reset in 20 chains, and a near alarm at an isolate boundary did.

## Closed and Open

Closed: alarm isolation by `sync()` as a fix on the deployed site, the earlier alarm move as the cause of admin page resets, and the request's own alarm coming due near its end as the cause of the resets that remain under the floor.

Open: the cause of the remaining resets and of the generic storage reset, whether a longer floor reaches zero (300 requests per arm cannot tell a 5 s floor from a 15 s one), whether the retirement result holds on the deployed site, and whether request-only reuse changes the reset rate at the same drive. Retry safety after a reset is not covered here.

## See Also

- Report: [Storage Resets and the Growth Governor](../../TECHNICAL_REPORT.md#storage-resets-and-the-growth-governor)
- Module: [Continuation](../modules/continuation.md), which uses the same alarm discipline
- Related study: [Memory Accounting](memory-accounting.md) for the growth governor
