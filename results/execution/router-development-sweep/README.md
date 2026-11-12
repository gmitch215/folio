# Router Development Sweep

Question: on the 38 development drivers, what does the router (`src/router.ts`, `ROUTER_VERSION` `folio-router-2`) gain over native serial on a quiet machine, and how much of the gain rests on a few drivers?

Result: the router's geomean over the 38 drivers is 1.209 with a driver-level bootstrap interval of 1.068 to 1.395 (10,000 resamples, seed 12345), and the slowest 10% of drivers read 0.981. The probability that the geomean reaches 1.20 is 0.5157. The point estimate meets the development target (1.20 and 0.90 for the slowest tenth) and the interval does not exclude 1.0. Without `qoa-encode` the geomean is 1.182. With `sha256-shared` at 1.0 it is 1.160, and with both window drivers (`sha256-shared`, `jsmn-parse-shared`) at 1.0 it is 1.149. The 1,140 rows of the third sweep have 0 errors and 0 wrong outputs, and 0 of 1,140 samples overlap another container above 10% CPU.

This is a development result. The 38 drivers were also the data the router constants were fitted on. Nothing here measures the final corpus.

## Design

x86_64 Ryzen 9 9900X, container with ten CPUs, 8 workers, ten paired rounds per sweep, a fresh process per row, arms rotated. The first two sweeps overlapped other containers (810 and 453 of 1,140 samples flagged) and read 1.238 and 1.247. Pooled over the three sweeps (3,420 rows, 30 rounds) the geomean is 1.227.

## Inputs

| File | Contents |
| --- | --- |
| `raw/dev-run.jsonl`, `raw/dev-run-2.jsonl`, `raw/dev-run-3.jsonl` | one row per sample: driver, arm, round, `wallMs`, route decision and reason, whether the output passed |
| `dev-analysis.json`, `dev-analysis-2.json`, `dev-analysis-3.json` | per-sweep analysis: variants, bootstrap intervals, contamination join |
| `dev-analysis-pooled.json` | the two-sweep pool (2,280 rows, geomean 1.244) |
| `dev-analysis-pooled3.json` | the three-sweep pool |
| `raw/*.sampler.tsv` | container CPU samples used for the contamination flag |
| `sweep.log` | the sweep log |

## Instrument

`node scripts/research/router-ablation.ts run results/execution/footprint/probe.json OUT --rounds 10 --modes serial,router,today`, then `summary OUT --json FILE`. The bootstrap interval and the sampler join come from a scratch analysis script that is not in `scripts/research/`.

## Limits

The qoi pair certifies on today's tree, and this sweep ran before the rebuild with both routed to `serial/allocator-state`. The router changed twice after these sweeps. The sweeps were not rerun, and the five modes were not rerun over the 38 drivers. Quote the pooled figure from `dev-analysis-pooled3.json`, not `dev-analysis-pooled.json`.
