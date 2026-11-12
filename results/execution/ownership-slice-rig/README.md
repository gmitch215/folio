# Ownership Slice Rig

Question: what does the in-place slice route and the iteration-pool redirect route buy over serial on `aes-cbc-decrypt-shared`, measured on a quiet machine?

Result: the slice route at 8 workers reads 4.07x of serial with six CPUs (range 1.92 to 5.96) and 5.64x with ten (3.38 to 6.20). At 4 workers it reads 3.19x in both settings, at 2 workers 1.70x and 1.68x, and at 1 worker 0.84x and 0.83x. Redirecting the window costs 1.16x per thread. The iteration-pool redirect route does not pay: 0.76x at 8 workers with six CPUs, 1.10x with ten, and one worker 0.16x.

## Design

256 records, 15 paired rounds, a fresh process per arm, arms rotated, on a quiet x86_64 Ryzen 9 9900X in a container with `--cpus 6` and again with `--cpus 10`. Speedup is the median over rounds of serial time over arm time. Every row records whether the output is correct. The Wasm modules timed are the ones built on the Mac (same SHA-256), because the clang on the rig produces different bytes.

## Inputs

| File | Contents |
| --- | --- |
| `slices-c6.jsonl`, `slices-c10.jsonl` | rows `{round, arm, n, ms, correct, loadStart, loadEnd}` for `serial`, `serial-redirected` and the slice route at 1, 2, 4 and 8 workers |
| `redirect-c6.jsonl`, `redirect-c10.jsonl` | the same for the iteration-pool redirect route |
| `*.sampler.tsv` | host load samples taken while the rows ran |
| `matrix.log` | the run log |

## Instrument

`scripts/research/ownership-slices-timing.ts run ROUNDS OUT` and `ownership-redirect-timing.ts`. The container recipe, the per-sample driver and the interval script were scratch files and are not part of this study.

## Limits

The 8-worker arms are noisy: a six-CPU quota serves eight workers and the main thread. The medians were recounted from the raw rows. The bootstrap intervals in the run notes (3.36 to 5.44 and 4.20 to 5.87) were not rerun. A Mac run on a loaded machine (3.34x and 2.78x) is indicative only and is not part of this study. One driver only.
