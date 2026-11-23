# Isolate Life

How long does a Durable Object stay in one isolate under a continuous CPU chain, and what does a move cost?

## Instrument

`experiments/continuation/life` runs five objects per arm for 60 seconds of CPU each, with slices of 0.1 s (`s01`), 1 s (`s1`), 5 s (`s5`) and 1 s with a 10 s idle pause after 3 s of isolate CPU (`g`). Each slice writes a row to Durable Object storage before it burns, so a slice that completes is visible in storage.

## Rows

`raw.jsonl` holds one `object` row per object and one `slice` row per slice. Isolate ids are replaced by an ordinal within each object. `startMs` is measured from the object's first slice.

## Reproduce

```sh
node experiments/continuation/build.ts
node experiments/continuation/life/run.ts s01    # deployed arms need account variables
node experiments/continuation/export.ts
node scripts/analyze/continuation.ts
node scripts/research/evidence.ts
```

## Scope

The rows come from storage, so a slice that burned and was reset before its row update would not appear as complete; no such slice was observed. Tail records were sampled, so per-slice CPU is not reported here. The cause of the gap between a move and the next slice is not established.
