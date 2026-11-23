# Lane Pool

Whether a durable lane pool turns independent CPU units into wall-clock gain on Durable Object lanes, and whether its leases replay a lane that resets. The pool is `LanePool` and `serveLane` in `src/managed/`. The workload is a generic bench job: 16 independent units that fill a 64 KiB chunk from a seed, then hash and run-count it, calibrated to about 190 ms each.

Run 1 of Version 1 rejected on a Workers Paid account and Version 2 stopped at calibration. Their records are in [lane-pool-check1](../../results/managed/lane-pool-check1/README.md) and [lane-pool-check2](../../results/managed/lane-pool-check2/README.md). No further run is planned. The speed is a calculation: `node experiments/lane-pool/model.ts` fits the fixed overhead to the five valid pairs of run 1 and projects serial over pool by unit cost.

## Pre-Registered Line

### Version 2

Fixed before the second run, on a Workers Paid account, at k = 4 lanes. The three clauses and the 1.2x threshold are the Version 1 text below, with two changes to what counts as a pair: a pair is valid only when both arms returned HTTP 200, and the gain is the median over the valid pairs. Fewer than 10 valid pairs rejects.

Run 1 rejected for four reasons:

- The cost of one unit varied about 6x between runs on fresh objects: about 0.1 to 0.3 ms a pass in some, 1.0 to 1.8 ms in others. The records do not isolate the cause.
- The serial arm returned HTTP 500 after 7.5 to 8.2 s in 5 of 10 pairs. At the slow cost, 16 units of 466 passes pass the 5 s CPU limit, so the CPU limit is the likely cause. The record kept 500 characters of the body and could not confirm it.
- Calibration took the median of five draws from that mix, ended after three steps without checking that they agreed, and ran on at a pass count whose last measurement was 476 ms a unit against a 100 ms target.
- The burn was sized from the slow 1.02 ms a pass, 14,676 passes. The lane finished it inside the 1.95 s call, at most 0.13 ms a pass, so it never reached the CPU limit and no lane reset.

What changed:

- Calibration times a call with the shape of the timed serial arm: a fresh object and 16 units. It makes 5 empty calls and 2 discarded warmups, then 3 calls per pass count. It stops before any timed pair, with a named reason, if the 3 calls differ by more than 25 percent, if any call fails, or if 190 ms is not reached in 6 pass counts.
- The unit target is 190 ms. The margin allows at most (1 - 0.25) x 5000 / 16 = 234 ms, and the calibration tolerance of 20 percent keeps the top of the band under that. The CPU limit is unchanged.
- The burn is sized for three times the CPU limit at the fastest pace seen in calibration and in the valid serial arms.
- A response other than 200 saves its body (up to 16 KiB) and headers, scrubbed. A fault run that did not return 200 is reported by its status.
- The burn arm records each rejected lane call with its message.

Versions 1 and 2 differ in the unit size, 100 ms to 190 ms, which comes from the CPU arithmetic and not from a target gain.

### Version 1

Fixed before any run, on a Workers Paid account, at k = 4 lanes:

- Wall gain of at least 1.2x. The gain is the median, over 10 pairs, of the serial arm's client wall over the pool arm's client wall. The two arms run the same units on the same worker, and the first arm of a pair alternates.
- Outputs equal to the serial run in every pair and in every fault run.
- Every injected reset replayed exactly once. The injected task has two claims, every other task has one, and every task has one accepted completion.

Reject if any clause fails, including a fault that did not reset a lane. A pool that is slower than serial at 100 ms units is a result, and so is a rejection.

## Arms

| Arm    | What runs                                                                                                      |
| ------ | -------------------------------------------------------------------------------------------------------------- |
| Serial | One Durable Object runs the 16 units one after another.                                                        |
| Pool   | A coordinator object submits 16 tasks, four lane objects on distinct ids claim them one at a time, and `fold`. |
| Burn   | The pool arm, with one task that burns three times the worker's CPU limit on its first attempt.                |
| Sleep  | The pool arm, with one task whose lane sleeps for 1.6 leases on its first attempt and renews nothing.          |

The serial arm sends the same kind of request through the same worker, so both arms pay the request hop to a Durable Object. Each pair uses a fresh coordinator name. The lane objects are touched once before the timed pairs.

## Instrument and Samples

Client wall time of one request, taken by the driver. The clock inside a Worker does not move during a loop, so the units are calibrated the same way: serial calls of 16 units on fresh objects, net of an empty call, scaled to about 190 ms and required to agree. The burn length comes from the fastest cost per pass seen.

- 1 warmup pair, then 10 timed pairs, 16 units each.
- 3 runs of the burn arm and 3 of the sleep arm, each on a fresh coordinator with a different injected task. After each run the driver waits for the late lane, then reads the coordinator's claims per task and its outcome rows.
- Lease 8 s. CPU limit 5 s, set in the deployed config.

## Running

```sh
node experiments/lane-pool/run.ts --dry-run      # the plan, counts and price, no Cloudflare call
node experiments/lane-pool/local.ts [passes]     # one serial and one pool run on local workerd
node experiments/lane-pool/run.ts                # live, paid account
node experiments/lane-pool/run.ts --analyze NAME # re-apply the decision to a saved run
```

A live run reads `FOLIO_CLOUDFLARE_ACCOUNT_ID` and `FOLIO_CLOUDFLARE_API_TOKEN`. It refuses the Free plan pair. `worker.ts` holds the coordinator and lane classes, `task.ts` the unit, `plan.ts` the schedule, the arithmetic, the price and the decision rule, and `run.ts` the driver. `tests/integration/managed/pool.test.ts` runs the pool arm on local workerd, with a lane reset by `ctx.abort()` as the stand-in for the burn.

## Cost and Safety

The dry run prices the plan before any call: worker requests, Durable Object requests, CPU and an assumed active time for every object, at list rates with no allowance applied. The total is under two cents against a stated cap of $1. The multipliers are the 16 tasks, each claimed and completed once (2 calls each), the 4 lane calls, the 6 fault runs and up to 25 calibration calls. A run refuses to start when the plan is over the cap, and stops at twice the planned request count.

The driver follows the metered-spend rules:

- It snapshots the account's Workers, Durable Object namespaces, KV, R2 and D1 before it deploys and after it deletes, and fails if anything of its own is left.
- It deploys one Worker under a fresh name, waits 90 s after the deploy, and deletes the Worker and its Durable Object classes at the end, in a `finally` block. Object names carry the run name.
- Raw rows go to the ignored `runs/` folder. No account id, token or workers.dev name is written to a tracked file.

## Limits

- Local workerd runs the lane objects in one isolate, so it shows exactness and replay and says nothing about overlap. The deployed run measures overlap.
- The burn arm depends on the platform ending an invocation that passes its CPU limit and rejecting the lane call. A run where no lane call rejects counts as not injected, and the line rejects.
- One account, one coordinator location and one unit size. A result applies to units of about 190 ms with small arguments.
- The serial arm computes on a fresh object each pair and the pool arm on four reused lane objects. Run 1 does not say whether the slow runs belong to fresh objects.
- A replay is bounded below by the lease length and the alarm floor, so a replay costs at least the lease length.
