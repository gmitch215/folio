# Range Lanes Over Service Bindings

Question: when ordinary Workers (no Durable Objects) serve as managed lanes over service bindings,
does shipping learned byte ranges instead of a full snapshot cut the bytes sent and the wall time,
with the same final memory as a serial run?

The decision rules below are fixed before any deployed run. Nothing here has been deployed yet; the
local workerd numbers are in the lane's result file and are not a speed claim.

## Setup

One coordinator Worker runs `ManagedFolio` and reaches four lane Workers through service bindings
(`LANE1` to `LANE4`). A lane is a `WorkerEntrypoint` with `execute(frame)` over `FolioLane`. Five
scripts on the Free account, no Durable Object, no storage. The kernel rewrites four partitions of
16 KiB, one call each, for four waves. `prepare.ts` builds and pins it (`sourceSha256` is in the
build metadata and in every response). The arena is 128 KiB, 1 MiB, 8 MiB or 32 MiB; the kernel
touches only the four partitions, so the rest is fill.

Arms, each in its own request:

- `snapshot`: the existing backend, dense snapshots, library defaults. At 32 MiB the snapshot is over
  the 31 MiB default `maximumSnapshotBytes`, so it sends nothing and runs natively at the owner. That
  row measures the existing limit, not a transport.
- `ranges-cold`: `ranges` option on, a fresh footprint cache.
- `ranges-warm`: the cache the cold request left in the same isolate. A warm request whose own report
  shows escape rounds or no footprint hits is classified cold and is not a warm sample.
- `serial`: `parallel: 'off'`, native at the owner.

Fills: `zero` (outside the partitions the arena is zero) and `random` (every byte outside the
partitions is nonzero xorshift output). The random fill is the control for a platform that treats
zero bytes specially, the listed limit of the earlier probe.

Exactness: every response carries a 64-bit digest of the whole arena and the kernel's return value.
A sample is exact when both equal the serial sample of the same round and cell.

## Wall, CPU and invocations

Wall is the client-observed time of one request, the same instrument for every arm. The in-Worker
clock only advances on I/O, so a serial request reads about zero inside the Worker; the in-Worker
wall is recorded but never used for a rule. Client wall includes the network path, which every arm
shares.

CPU comes from `wrangler tail --format json` on all five scripts (no metered cost). A coordinator
event names its request by the `rid` query parameter; a lane event belongs to the coordinator event
whose time span holds it. `cpuTime` is whole milliseconds. Whether tail delivers every event on the
Free account is not verified before the first run; the summary states how many requests got CPU. With
none, the fallback is `laneWallMs`, the coordinator's wall around each lane call, which is not CPU.

Invocations per request are counted by the coordinator at the transport (one per lane call, plus the
coordinator). The driver adds them up, stops at a stated cap of 6,000 and refuses to start when the
plan exceeds it. `--dry-run` prints the plan.

## Kernel size

The serial arm runs all the compute in one Free request, which the platform stops at 10 ms of CPU.
Calibration runs the serial arm at 8 MiB on a ladder of kernel rounds (2, 4, ... 256), eight trials
each, stops at the first rung with a refused request, and keeps the rung one below the largest that
survived. The lane calls then carry one sixteenth of that compute each.

## Order and records

Each round runs eight groups (arena and fill) and four arms in each. Groups rotate by three and arm
slots by one every round; odd rounds run in reverse. Cold runs directly before warm. Two warmup rounds
come first, then ten measured rounds. Every request is appended to `runs/<name>/requests.jsonl` as it
finishes, failures included, with status, arm, cell, wall and the full body. `runs/` is ignored.

## Decision rules

1. Exactness: every sample is exact (digest and value equal to the serial sample of its round).
2. Bytes: at 8 MiB with zero fill, the median ranges bytes sent, cold and warm, are at most 5% of the
   snapshot bytes sent.
3. Wall against snapshot: at 8 MiB with zero fill, the ranges warm median wall is at most 0.8 of the
   snapshot median wall. The cold ratio is computed and reported beside it.
4. Wall against serial: the serial median wall is at least 1.5 times the ranges warm median wall.
5. Invocations: at most 24 per top-level request in any ranges request.
6. Failures: a cell with more than 2% failed requests is reported as a failure of the arm. A failure is
   a request that is not a 200, an inexact result, a lane error, or a native fallback that is not the
   documented 32 MiB snapshot limit. Medians use the requests that did their job and the failure counts
   and kinds stay in the same row.
7. Nonzero control: the ranges warm over snapshot wall ratio with random fill must agree with the zero
   fill ratio within 25%. If not, the zero-fill result is not claimed.

A second-account repeat is a separate record, named through `FOLIO_RANGES_RECORD`. The first record is
not quoted alone once a second exists.

## What each outcome means

- Rules 1 and 2 hold, 3 fails: the bytes are saved and the wall is not limited by bytes on this route.
  The earlier probe's rule applies: bytes are not the limiting cost here.
- Rule 3 holds, 4 fails: ranges beat the snapshot copy, but a single Worker with the whole compute is
  still faster. The serial arm can hold at most about 10 ms of CPU on Free, so rule 4 can only pass
  when the per-call overhead of a service binding is small against that. A failure of rule 4 on Free
  does not say anything about a larger compute.
- Rule 5 fails: the platform limit of 32 invocations per request is close; the driver reports the
  count per request and the fallback keeps results exact, but the route is not usable at that width.
- Rule 6 fails in the 32 MiB cells: a lane or coordinator is hitting a CPU or memory limit. The
  likely sources are the lane's first frame, which clears the whole memory (10.2 ms at 32 MiB on a
  Mac), and the owner's digest. These are recorded as failures of the arm, not removed.
- Rule 7 fails: zero bytes are treated differently from random bytes somewhere on the path, and the
  zero-fill numbers are not a claim.
- Rule 1 fails anywhere: no other result from that arm is used.

## Bounds

Free account only. The driver refuses a paid Workers subscription and, when the plan cannot be read,
an account that did not come from the Free pair. The planned total is 5,158 invocations at ten
rounds, about 5% of the 100,000 daily Free requests, counting every invocation as a request. No
Durable Object rows, no storage calls. The driver snapshots Worker scripts, Durable Object
namespaces, KV, R2 and D1 before it deploys, deletes the five scripts at the end and compares.

Limits: one coordinator location, four lanes, width four, one kernel family, wall as seen from one
client. The coordinator holds one arena at a time to stay under the 128 MB isolate limit. Lane memory
is as large as the arena because addresses are absolute.

## Durable Object lanes

`FOLIO_RANGES_LANES=do` replaces the service bindings with four Durable Object instances of one
`LaneObject` class, reached through `LANEOBJ.getByName(<owner name>-lane-<n>)`. The class wraps the
same `FolioLane` and exposes `execute(frame)` and `info()`. It never touches storage, so the
Durable Object row count stays at zero. Each of the two owners (the main one and the snapshot
one) carries its own class and its own four instances, and no lane Worker is deployed. The run
record and the summary carry `lanes: 'worker' | 'do'`.

Why: the concurrency probe measured four service-bound Worker lanes running one after another at
100 and 380 ms of CPU a call (overlap index 4.07 and 3.87) and four Durable Object lanes mostly in
parallel (1.42 and 1.42). Nothing else changes: same kernel, arms, order and decision rules.

A stub is tied to the request that made it. The warm arm keeps its transports between requests,
so the owner makes a fresh stub for every lane call. A first version that built the four stubs once
per pool failed every warm lane call locally with a different-request error and fell back to
native execution.

Invocation accounting: the platform docs say each call to a service binding counts toward the
limit of 32 Worker invocations in one request. They do not say whether a Durable Object stub call
counts, and no measurement here settles it. The plan counts every lane call as an invocation in
both modes, which is the conservative reading, and also prints the reading where stub calls do not
count (one invocation a request). The driver counts invocations the same conservative way.

Cleanup: Durable Object owners are retired (class deleted by migration, then the script) before
deletion. The account check lists Workers, Durable Object namespaces, KV, R2 and D1 before and
after, treats an entry as the run's own when its name or script starts with `cfw-folio-ranges-`,
fails the run on any own leftover, and records other changes separately without touching them.

CPU for a Durable Object lane comes from tail events of the owner's own script that carry
`rpcMethod` `execute`. Whether `wrangler tail` labels Durable Object calls that way is unverified;
the summary states how many requests got CPU and `laneWallMs` remains the fallback.
