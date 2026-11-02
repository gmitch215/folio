# Admission Estimator

Question: when a loop's records differ in size, which estimate of the remaining serial work should the probe of a refused loop use, and does a change cost the equal-size set anything?

## Method

After iteration 0 the iteration route times a refused loop in growing serial blocks and re-admits it when the remaining iterations times the estimate exceed the 2.5 ms floor. The estimate was the lower of the last two block means. `admissionSeam.estimator` now selects one of four, through `C21_ESTIMATOR` in `scripts/research/c21-bench.ts`: `min` (the old rule), `median` of every block mean so far (iteration 0 included), `mean` of every probed iteration, and `q75`, the 75th percentile of the block means. Each ran the automatic arm only, eight workers, three sessions of five rounds, one fresh process per cell on the Ryzen 9 9900X under the timing lock (`nice 19`, CPUs 4 to 11), on two sets: the 30 drivers at equal record sizes, and the eight programs whose records can be cut to any length with `C21_MIXED=1` (records of 1, 1/2, 1/4, 1/8 or 1/16 of the largest in a fixed pattern, the first record being 1/8). `est-eq-*.md` and `est-mx-*.md` are the arm tables. `admission-quality-*.md` is `scripts/research/admission-quality.mjs` with each estimator's automatic cells beside the forced and explicit cells of `../record-level-rig` and the in-place cells of `../slice-pool-census`. `raw.tar.gz` holds every raw row and log.

## Results

Mixed record sizes, automatic admission, speedup over serial (forced at the same sizes: MD5 1.21, CRC-32 1.56, SHA-256 1.44, SHA-1 1.19):

| program | min | median | mean | q75 |
| --- | ---: | ---: | ---: | ---: |
| MD5 | 0.98 | 1.03 | 1.05 | 1.00 |
| CRC-32 | 0.98 | 1.10 | 1.04 | 1.07 |
| SHA-256 | 1.38 | 1.50 | 1.33 | 1.36 |
| SHA-1 | 1.13 | 1.23 | 0.98 | 1.23 |
| Adler-32 | 0.96 | 0.95 | 0.49 | 0.44 |
| xxHash3, xxHash32, xxHash64 | 0.79 to 0.89 | 0.77 to 0.90 | 0.79 to 0.88 | 0.79 to 0.87 |

Equal record sizes, 30 drivers: all four estimators admit 17 loops and win on the same 7. Mean regret against the best measured tracked mode was 0.167 (min), 0.186 (median), 0.155 (mean) and 0.150 (q75); two runs of the min estimator, on the same rig some hours apart, gave 0.172 and 0.167, so a difference of 0.02 is not established and the four are not separated.

The median recovers MD5 and CRC-32 to a small win and lifts SHA-256 and SHA-1, with no new loss, and it is the only estimator that does so without the Adler-32 collapse that the mean and the 75th percentile cause (0.49 and 0.44: they admit a loop whose tracked route loses). It does not reach the forced route's 1.21 and 1.56, because admission still waits for the probe blocks. The median is the default.

## Record sizes that change inside one pool

`scripts/research/size-change.ts` opens one pool and calls the same loop 18 times, three calls with records cut to 1/16 of their size, then three at full size, three cycles, for MD5, SHA-256, SHA-1, miniz CRC-32 and xxHash32 (three sessions, fresh process each; `size-change.md`, `size-change-raw.tar.gz`, table by `size-change-table.mjs`). The question is whether the verdict of a call that stopped keeps a later call with larger records from dispatching. It does not: the first full-size call after small ones runs speculatively, with speedups at that call of 0.90x (MD5), 1.40x (SHA-256) and 0.86x (miniz CRC-32) that rise over the next calls to 1.42x, 1.82x and 1.50x by the ninth call, and the small-record calls run serially at 0.84x to 0.94x for MD5, SHA-256 and miniz CRC-32 because of the refusal path. xxHash32 ran serially at both sizes in 17 of the 18 calls (the most common mode over the three sessions) and speculatively in one.

## Scope

- One machine, one size pattern, and a loop count of 128 or 64 records, so a block mean rests on few iterations. A pattern with a period that matches the block growth could still bias the median.
- The equal-size comparison is within run-to-run noise; it shows no cost, not an improvement.
- A refused loop still pays the per-iteration call into the replay function, 3 to 13 percent on cheap records; the estimator does not change that.
