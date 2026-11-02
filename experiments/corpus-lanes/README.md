# Corpus Lanes

Corpus kernels as managed range lanes over Durable Objects. One owner Worker runs `ManagedFolio`
with the `ranges` option and reaches four `LaneObject` instances per driver. See
[METHOD.md](METHOD.md) for the question and the decision rules.

```sh
node experiments/corpus-lanes/prepare.ts                    # build and pin the artifacts
node experiments/corpus-lanes/run.ts --dry-run              # plan, owner CPU estimate, list-rate price
node experiments/corpus-lanes/run.ts                        # live, needs credentials
FOLIO_CORPUS_PLAN=paid node experiments/corpus-lanes/run.ts # live on a paid plan
```

`prepare.ts` always builds `synthetic-sum`. The corpus drivers (`miniz-crc32`, `xxhash32`,
`md5-slot`, `aes-cbc-encrypt-slot`, `jsmn-parse-slot`) are read from `build/research/x1` and
skipped when absent. `FOLIO_CORPUS_ONLY` limits a live run to some driver ids, and
`FOLIO_CORPUS_ROUNDS` sets the rounds.

`drivers.ts` holds the records and memory layout, `measure.ts` the batch sizing and the lane
meter, `plan.ts` the schedule, price and decision rules, `coordinator.ts` the owner and lane
object, and `local.ts` the local workerd harness. No live run is recorded for this project yet, and
its typecheck needs the generated `artifact.ts`, so it is outside `bun run typecheck`.
