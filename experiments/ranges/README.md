# Range Lanes

Ordinary Workers as managed lanes over service bindings, with `ManagedFolio` shipping learned byte
ranges instead of snapshots. See [METHOD.md](METHOD.md) for the question and the decision rules.

## Running

```sh
node experiments/ranges/prepare.ts                             # build and pin the kernel
node experiments/ranges/local.ts [repeats]                     # the matrix on local workerd
node experiments/ranges/run.ts --dry-run                       # the deploy plan, no Cloudflare call
node experiments/ranges/run.ts                                 # live, Free account only
FOLIO_RANGES_LANES=do node experiments/ranges/run.ts --dry-run # Durable Object lanes
```

`lane.ts` is the lane Worker, `coordinator.ts` the owner, `plan.ts` the schedule, bounds and
decision rules, `kernel.ts` and `layout.ts` the kernel, the arena fill and the digest.
`tests/integration/experiments/ranges/ranges.test.ts` runs the real service-binding transport on local workerd.

`FOLIO_RANGES_LANES=do` swaps the four lane Workers for four SQLite-backed Durable Object lanes
(`LaneObject` in `coordinator.ts`, bound as `LANEOBJ`), named from the run so each run gets new
instances. The default is `worker`. `wrangler.coordinator.do.jsonc` is the local test config for it.

`FOLIO_RANGES_FUEL` sets the speculative fuel of a run (the coordinator's `fuel` parameter).

## Output

A live run writes its raw rows to the ignored `runs/` folder. The sanitized record is
[range-lanes](../../results/managed/range-lanes/README.md).

## Limits

- The managed default of 100,000,000 back-edges per call runs out on the longest kernels, and the owner
  then finishes the call serially. A 65,536-round run needs `FOLIO_RANGES_FUEL=1000000000`.
- A live run with service-bound lanes needs a Free account. Durable Object lanes name new instances for
  each run.
