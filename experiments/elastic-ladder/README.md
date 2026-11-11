# Elastic Ladder

The synchronous tiers of the elastic-memory ladder: one Durable Object runs a program whose pages live in its own SQLite (V4), with a compressed pool in front of that storage (V6). No stub call sits on the page path. The question is whether the 192 MiB dense fixture, which took 392 s with remote page owners, can run in one object.

Nothing here runs live by default. `live.ts` without `--approved` prints the price and sends nothing.

## Files

- `engine.ts` holds `Pager` (resident frames, an optional compressed pool, a backend) and `runSegment`, which runs a Wasm program until it ends or a quantum of page operations has run. Suspension is the Codex fixture's: Asyncify unwinds, the 64 KiB memory is the checkpoint, and the completion of the last operation travels with it.
- `store.ts` has `SqlBackend` (rows in `ctx.storage.sql`), `MemoryBackend` (a fake store with a virtual clock) and the `Backend` interface.
- `service.ts` is the object (`init`, `run`, `verify`, `clear`) and the front-Worker `route`. `worker.ts` is the only Cloudflare-specific file.
- `programs.ts` defines the four workloads, their page contents and their oracles. `trace-build.ts` builds the skewed, scan and chase module. The dense program is the frozen Codex `fixture.wasm`.
- `plan.ts` holds the variants and the price function. `predictions.ts` writes the model's counts before a sweep. `driver.ts` is the client loop, `live.ts` the deploy driver, `local.ts` the in-process world, `sweep.ts` the full-scale local sweep, `workerd.ts` a smoke test on local workerd.
- `lz4.ts` and `wasm/` are the LZ4 block codec: `lz4_wasm.c` over the vendored LZ4 1.10.0 source in `wasm/lz4/`. `lz4-build.ts` builds `build/lz4.wasm` with clang when an input is newer, and `wasm/source.json` pins the source and the output.

## Variants

A variant is a record in `plan.ts`: resident frames, pool capacity in pages (0 for none), bytes per row and a quantum of operations per request.

| Variant | Frames |        Pool | Row    | Quantum     |
| ------- | -----: | ----------: | ------ | ----------- |
| `v4`    |     64 |           0 | 64 KiB | one request |
| `v6`    |     64 | 1,024 pages | 64 KiB | one request |

`v4e` is a V4 with request-scoped frames: a dirty frame is written only when it is evicted, and nothing is written back when the request ends. Its store is not the state afterwards, so a `v4e` result is never a persistent-state result and it sits outside `VARIANTS`. At 768 pages with 768 frames it moves no rows. `unpaged` keeps every page in one buffer with no store.

The default row is 64 KiB, one row per page. E1d found that rows of 6 KiB or more hold everything written in platform memory (about 34 MiB at the cap), and that 4 KiB rows hold 0.12 to 0.19 of it at 256 rows per MiB. A 4 KiB row at full scale costs about 98,000 rows for a dense run, so `plan.ts` prices it and the live driver refuses it under the default row cap.

## Commands

```sh
node experiments/elastic-ladder/prepare.ts
node experiments/elastic-ladder/live.ts --variants v4,v6 --workloads dense --row-cap 13000
node experiments/elastic-ladder/predictions.ts OUT.json 3072
node experiments/elastic-ladder/sweep.ts OUTDIR OUT.json 3072
node experiments/elastic-ladder/workerd.ts 96 64
```

`prepare.ts` copies the fixture to `build/`, builds the LZ4 codec there and builds the trace module. The live run needs `FREE_CLOUDFLARE_ACCOUNT_ID` and `FREE_CLOUDFLARE_API_TOKEN`, and a run directory under `runs/` here, which is git-ignored.

## Limits

- The pool counts pages, not bytes, so the model's counts are exact. Its bytes are reported per run.
- Frames and the pool live in the object between requests. A resume that reaches a restarted object is refused with a 409, never run on lost frames.
- Rows read are exact at 64 KiB rows. A range read of a smaller row size reads one row past the page when a next row exists, so the price is a lower bound there.
- Time inside a Durable Object does not advance during synchronous work, so per-page codec time comes only from local runs. A live run gets wall time per request.

## Day 2 analysis rules

Fixed on 10 Nov 2026 before any day 2 run. `day2-predictions-nnls.json` holds the gate model B2, the time model fit by non-negative least squares on the ten exact day 1 runs, and the predicted wall time of every planned day 2 cell. `day2-predictions.json` holds model B1, the unconstrained fit of the same form, which has negative read and codec costs; it is reported beside B2 and does not gate.

- p90 is the nearest rank over completed repeats: sort the run walls and take the value at rank ceil(0.9 n).
- A failed or stalled attempt counts as a run over the threshold. The exception is a stall where the heartbeat log proves the work finished inside the threshold and the stall was client-side: heartbeat lines kept their 1 s spacing, or the object's own counters show the run completed.
- The 2x unpaged comparison uses a request that fits unpaged: unpaged against V4 with frames equal to the pages (768 frames at 768 pages, every page resident), run back to back at the same time of day. The 64-frame paged cell at 768 pages is an extra cell and does not enter the 2x gate.
- The model gate counts a variant as met when B2 predicted over measured is within 20% on day 2, using `day2-predictions-nnls.json` as written. The model is not refit before that comparison.
- No cell is dropped after its result is seen. A cell that cannot run is reported as not run.

## Day 3 analysis rules

Fixed on 11 Nov 2026 before any day 3 run. Every day 2 rule above stands. `day3-predictions.json` holds model C, the same time form as B2 fitted by non-negative least squares on every completed exact run at 3,072 pages of days 1 and 2 (18 runs), and the predicted wall time of every planned day 3 cell. B1 and B2 predictions sit beside each cell and never gate.

- The model gate counts a variant as met when model C predicted over measured is within 20% on every day 3 cell of that variant at 3,072 pages. The model is not refit before that comparison.
- The dense p90 rule is unchanged. A failed attempt counts as over, so a run of `f` failures needs at least `9 f` completed runs before the rule can pass.
- A `v4e` run is reported as a different mechanism. It never enters the dense p90, the model gate or a persistent-state claim.
- The pair for the 2x comparison stays unpaged against `v4` with frames equal to the pages, run back to back.
