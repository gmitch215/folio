# Concurrent Lane Calls

Question: when a coordinator issues four lane calls at once, do they overlap on the deployed
platform, and which lane type or placement restores overlap when they do not?

The decision rule and the predictions below are fixed before any deployed run. Nothing here has
been deployed. The local workerd readout (`node experiments/concurrency/local.ts`) gives an index
near 4 for every arm, which agrees with the report entry that one workerd process runs CPU-bound
requests one at a time. It says nothing about the platform.

## Why

Three paid range-lane runs showed four lane calls that did not always overlap. Lane CPU over
lane wall (tail events, `rpcMethod` `execute`) was 0.81 at 4,096 rounds, 0.91 at 16,384 and 0.47 at
65,536, where the median lane wall was 369 ms for 341 ms of CPU and the 90th percentile was 2,299
ms. In one request the first wave of four lanes took about 335 ms and later waves took about 1,000,
2,100 and 2,300 ms for identical work. The earlier 4 ms overlap probe gave an index of 1.42.

The Workers documentation says service-bound Workers run on the same thread of the same server by
default, and that Durable Objects may run in the same isolate on the same machine.

## Hypotheses

- H1: lanes reached through service bindings share one thread, so long synchronous CPU calls queue
  behind each other and short calls only look parallel.
- H2: CPU contention from other tenants or from other jobs on the same account, unrelated to how
  many calls this probe makes at once.
- H3: per-isolate CPU throttling after sustained CPU, so wall inflates with the CPU an isolate has
  already spent, not with concurrency.

## Setup

One coordinator Worker (`coordinator.ts`) holds four service bindings to four lane Workers
(`lane.ts`, `LANE1` to `LANE4`) and a Durable Object namespace (`LaneObject`). Five scripts. The
kernel (`prepare.ts`) is a Wasm linear congruential loop with a `rounds` parameter and no memory
traffic. Every call returns the loop's result, and the driver checks it against the same loop in
JavaScript.

Arms, one request per cell unless noted:

- `worker`: the coordinator calls four different lane Workers over service bindings.
- `worker-one`: the coordinator calls one lane Worker four times at once. Control for concurrent
  calls into one script.
- `do-same`: four Durable Object instances, default placement.
- `do-hint`: four Durable Object instances, each created with a different `locationHint` (`wnam`,
  `enam`, `weur`, `apac`). Instance names carry the run name, so every instance is new and the hint
  applies at creation. A hint is a best effort, so the placement recorded after the run says where
  they landed.
- `direct`: the driver sends four separate top-level requests at once, each to its own lane
  Worker's workers.dev route. No coordinator is involved.

Levels: `empty` (0 rounds, the fixed cost), `low` (about 70 ms of CPU per call) and `high` (about
340 ms). Widths: one call alone, and four at once.

## Calibration

The clock inside a Worker does not move during a loop, so the levels cannot be timed there.
Calibration uses one call alone through `worker-one`, in client wall minus the median empty-loop
wall. A probe of 1,000,000 rounds (larger by ten times until it nets at least 10 ms) fixes the
rate, the two levels scale from it, and up to two verification passes of three calls each rescale a
level that is more than 20% from its target. The realized CPU per call comes afterwards from the
tail events (`cpuMsPerCall`), and that figure is the level a result is quoted at. The tail reports
whole milliseconds. `FOLIO_CONCURRENCY_ROUNDS_LOW` and `FOLIO_CONCURRENCY_ROUNDS_HIGH` skip
calibration and fix the rounds.

## Order and records

Twelve measured repetitions after one warmup repetition. A repetition runs all 30 cells (five arms,
three levels, two widths). The six level and width blocks rotate by one each repetition, the arms
inside a block rotate by the repetition plus the block index, and odd repetitions run in reverse.
There is no pause between cells, so sustained use is part of the measurement. Every cell is
appended to `runs/<name>/requests.jsonl` as it finishes, failures included. `runs/` is ignored.

Per call the record holds the client wall of the cell, the lane instance, a per-isolate random id
(to count distinct isolates), the call ordinal inside the isolate, the lane's own `Date.now()` at
entry, and the coordinator's data center from `request.cf` for coordinator arms and the lane's for
`direct`. Each lane logs one line `{probe, rid, slot}`, and `wrangler tail --format json` on all five
scripts gives the platform's `cpuTime` and `wallTime` for the invocation that logged it. The join
key is that line, so no clock is compared. Placement of every lane and object comes from a
`/where` request after the run, which asks each instance for its data center through
`cdn-cgi/trace`. It can be null.

Whether the tail delivers every event, and whether it delivers Durable Object events, is not
verified before the first run. The summary reports `eventCoverage` per row, and a row without
coverage gives no verdict.

## Measures

For each arm and loaded level, from the median over usable repetitions:

- Overlap index = (wall of 4 at once minus empty-loop wall of 4 at once) over (wall of 1 minus
  empty-loop wall of 1). The empty loop is taken at the same width, so a fixed cost that grows with
  width, such as four connections for `direct`, cancels. For `direct` the wall of a cell is from
  the first send to the last response. An index below 1 is possible and means a smaller fixed
  cost, not faster compute.
- CPU over wall, over the lane events of the four-at-once cells: summed `cpuTime` over summed
  `wallTime`. Sums count the stragglers, which a median of ratios would hide. The median of per
  event ratios and the share of events below 0.8 are reported beside it.
- Distinct isolates answered: the number of different per-isolate ids among the four calls
  (median per request) and across the whole cell.
- Spread: wall minimum, 10th and 90th percentile (nearest rank) and maximum.
- Start spread: the largest difference between the four entry times. Clocks of different
  machines can disagree, so this is indicative only.

## Decision rule

Overlap counts as established for an arm at a level when the index is at most 1.5 and CPU over
wall is at least 0.8. A verdict needs at least 6 usable repetitions in each of the four cells it
uses, otherwise it is null. A usable repetition is a 200 with every call answered and every result
exact. Failures stay in `requests`, `failures` and the verdict text, and a cell above 2% failures
is marked in the detail. The summary lists failures and never drops them.

## What each result would predict

| Arm          | H1 (one thread behind service bindings)                                                | H2 (other tenants or jobs)                                               | H3 (per-isolate throttling)                                               |
| ------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| `worker`     | index near 4, CPU over wall near 0.4 (calls queue behind one another)                  | index above 1.5 only in some repetitions; one-call cells also show waits | k = 1 cells also slow as calls accumulate per isolate; index near 1 early |
| `worker-one` | index near 4 (one isolate runs JS one call at a time); fewer than four isolates answer | same as `worker`                                                         | slowest to degrade first, since one isolate takes four calls per cell     |
| `do-same`    | index near 4 if the four objects share an isolate, near 1 if not                       | as `worker`                                                              | per instance, so late repetitions slow for each instance alike            |
| `do-hint`    | near 1 when the hints put the objects on different machines                            | as `worker`                                                              | as `do-same`                                                              |
| `direct`     | near 1, since no binding is involved                                                   | same noise as the other arms, in every arm and at k = 1                  | as `worker`                                                               |

The signals that separate them:

- H1 shows as a structure over arms: `worker` and `worker-one` high, `direct` and `do-hint` near 1,
  at both loaded levels, with the same CPU over wall in every repetition.
- H2 shows as no structure over arms. `belowShare` is similar in every arm, the one-call cells are
  affected as often as the four-call cells, the effect comes and goes between repetitions, and a
  second run on another day differs.
- H3 shows as drift. `driftFirstHalf` and `driftSecondHalf` (CPU over wall of the first and the
  second half of the repetitions) fall in every arm, the one-call cells slow too, and `call`
  ordinals inside an isolate correlate with wall.
- `worker-one` is a control. One isolate runs JavaScript on one thread, so an index near 4 is
  expected there under every hypothesis. An index near 1 would mean the platform scales one script
  out to several isolates for concurrent calls, which is a result of its own, and the isolate
  counts say which.
- A mixed result (for example `worker` high only at the high level) is reported as mixed and is
  not forced into one hypothesis.

## Account safety

The driver snapshots the account inventory (Workers, Durable Object namespaces, KV, R2, D1, with
modified times) before it deploys and after it deletes. Resources whose name or script starts with
`cfw-folio-concurrency-` are the run's own. A leftover own resource fails the run after the summary
is written. Any other change is written to `foreignChanges` with a short hash of its name and is
never touched, and does not abort the run. The coordinator is retired (its Durable Object class is
deleted) before the script is deleted.

Credentials come only from `FOLIO_CLOUDFLARE_ACCOUNT_ID` and `FOLIO_CLOUDFLARE_API_TOKEN`. They are
passed to Wrangler through its environment and are not logged. The probe token is a random value per
run, stored as a secret on every script.

## Bounds

The plan is 1,381 invocations at twelve repetitions, under a stated cap of 1,500, and 545 top-level
requests. `--dry-run` prints the plan and the list-rate price. Workers need the paid plan, since the
levels exceed the 10 ms Free CPU cap. The price uses the figures read from the pricing pages on
2026-11-02: Workers requests $0.30 per million over 10 million, CPU $0.02 per million ms over 30
million, Durable Object requests $0.15 per million over 1 million, duration $12.50 per million
GB-s over 400,000, billed at 128 MB, service binding calls adding no request fee. The monthly
included amounts are not applied, so the printed price is an upper bound on the marginal charge.
Durable Object duration is an assumption, every instance active for 900 s, and each Durable Object
call is priced as one request. The tail's `cpuMsInMeasuredCalls` gives the realized CPU.

Limits: one coordinator location (reported), four lanes, one kernel, client wall from one machine,
whole-millisecond CPU, a hint that may not be honored, and one account. A second account or a
second day is a separate record.
