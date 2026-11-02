# Lane Concurrency

Question: when a coordinator issues four lane calls at once, do they overlap on the deployed platform, and which lane type restores overlap when they do not?

## Method

One coordinator Worker, four lane Workers reached by service binding, and a Durable Object namespace of four instances, deployed on a paid account, measured and deleted. Each lane runs a pure Wasm loop whose length is set by a `rounds` argument and returns its checksum, which the driver checks against the same loop in JavaScript. The levels are about 100 ms and about 380 ms of CPU per call, calibrated from client wall minus the empty-loop wall because a Worker's clock does not advance during a loop.

Five arms, each run alone (one call) and four at once, 12 repetitions after one warmup, arms interleaved and rotated per repetition:

- `worker`: four different lane Workers over service bindings.
- `worker-one`: one lane Worker called four times at once.
- `do-same`: four Durable Object instances in default placement.
- `do-hint`: four Durable Object instances, each created with a different `locationHint`.
- `direct`: four separate top-level requests, no coordinator.

The overlap index is the wall of four calls at once minus the empty-loop wall, over the same for one call. 1.0 is full overlap and 4.0 is fully serialized. Lane CPU over wall comes from `wrangler tail` events (`cpuTime` and `wallTime` per invocation), joined to calls by a log line. The rule, fixed before the run in [METHOD.md](../../../experiments/concurrency/METHOD.md): an arm overlaps when the index is at most 1.5 and CPU over wall is at least 0.8.

## Results

| Arm | Index at 100 / 380 ms | Lane CPU over wall | Rule |
| --- | --- | --- | --- |
| `worker` | 4.07 / 3.87 | 0.27 | fails |
| `worker-one` | 4.13 / 3.94 | 0.28 / 0.25 | fails |
| `do-same` | 1.42 / 1.42 | 0.94 / 0.98 | passes |
| `do-hint` | 1.86 / 1.81 | 0.57 / 0.83 | fails |
| `direct` | 1.84 / 1.48 | 0.99 / 1.00 | passes at 380 ms only |

Four calls to four different service-bound Workers took about four times as long as one call, with lane CPU at 27% of lane wall. Four Durable Object instances took about 1.4 times as long as one call. Location hints placed the objects in different data centers and added round-trip time without improving overlap. The run created and deleted its own scripts and Durable Object class. The coordinator's data center was IAD, and the default-placement objects landed in IAD and EWR.

## Scope

- One account and one coordinator location. The platform documentation says service-bound Workers run on the same thread by default and that objects of one class can share an isolate; this run measures what those two lane types did over 12 repetitions and is not a guarantee.
- An earlier probe with a 4 ms kernel reported an index of 1.42 for service-bound Workers ([ordinary-worker-lanes](../ordinary-worker-lanes/README.md)). It does not reproduce at 100 and 380 ms, and the cause was not isolated.
- Tail event coverage was 25% to 100% by cell; cells with low coverage carry the CPU over wall from the events that arrived.
- The raw tail events here keep only timing, outcome, route and data center. Client addresses, headers and locations were removed at export.

## Artifacts

- `run/raw.jsonl`: every cell, failures included.
- `run/tail.jsonl`: one scrubbed tail event per line.
- `run/summary.json`: rows, verdicts, leftovers and foreign changes.
- `run/environment.json`: the run record, the calibration and the recorded placement.

## Reproduction

```sh
node experiments/concurrency/prepare.ts
node experiments/concurrency/run.ts --dry-run
FOLIO_CLOUDFLARE_ACCOUNT_ID=... FOLIO_CLOUDFLARE_API_TOKEN=... node experiments/concurrency/run.ts
node scripts/research/lane-evidence.ts experiments/concurrency/runs/<name> results/managed/lane-concurrency/run
```
