# Boundary-State Rig Runs

Question: what do the affine, state-in-memory, recorded-boundary, sweep and shared-input routes reach on a quiet machine, and does every timed sample equal the serial result?

## Method

Four stages ran in sequence on the Ryzen 9 9900X (Node 26.10.0, CPUs 4 to 11, `nice 19`, the timing lock, governor `powersave`, eight workers). Each stage ran three sessions of five timed rounds after two warmups, one fresh process per session; the shared-input stage ran one fresh process per cell. The wasm modules were built on another machine because the rig has no `wasm-ld`. `scripts/research/affine-rig.sh` is the runner (the run used the same stages from a scratch copy of it).

| stage | script | raw prefix | summary |
| --- | --- | --- | --- |
| scalar affine recovery | `affine-bench.ts` | `af1` | `affine-summary.md` |
| state in memory and recorded boundaries | `affine-state-bench.ts` | `af2` | `state-summary.md` |
| fixed-point sweeps | `sweeps-bench.ts` (`count`, `states`, `wall`) | `af3` | `sweeps-summary.md` |
| copied against shared task input, explicit arm | `c21-shared.sh` | `dx2/` | `shared-summary.md` |

`raw.tar.gz` holds every raw row, session log and before and after record (load, memory, governor). Every timed sample equals the serial state. One-minute load was 0.0 to 3.6 during the first three stages and 3.1 to 4.2 in the shared-input cells, where the eight pool threads count toward the figure.

## Results

At 64 MiB, eight workers, median of the session medians:

| route | result |
| --- | --- |
| miniz CRC-32, exact mode | 2.11x, against 3.45x for the hand-derived combine |
| CRC-32C, CRC-16, CRC-64, exact mode | 2.83x, 2.29x, 2.11x |
| `h * 31 + byte`, LCG, exact mode | 1.51x, 1.45x |
| CRC context in memory, exact mode | 1.96x; CRC beside a counter 1.84x; last-8 1.34x; polynomial hash 1.25x; Fletcher pair 0.52x |
| recorded boundaries, identical rerun | SHA-256 4.58x, SHA-1 4.51x, MD5 3.92x |
| recorded boundaries, edit 90, 50 and 10 percent in (SHA-256) | 3.45x, 1.51x, 0.86x |
| last-8 hash, edit that keeps the end state | 3.95x to 4.04x; 1.42x when the end state changes |
| UTF-8 DFA with and without sticky flag, zero guess | 3.54x and 3.40x at 1 sweep; the sticky flag needs 8 sweeps at 32 chunks on 64 KiB |
| CSV, Base64, run-length, CRC-32, SHA-256 sweeps | 8 sweeps at 8 chunks, 0.24x to 0.64x |
| explicit arm, shared against copied input, xxHash32 at 4,096 records | 0.54x against 0.22x |
| explicit arm, shared against copied input, Adler-32 at 4,096 records | 1.34x against 0.56x |
| explicit arm, shared against copied input, LZ4 decompress at 4,096 records | 0.49x against 0.47x |

The summary files carry every cell with its session range and CPU ratio.

## Scope

- One machine and one input stream per size. No width or size sweep for state in memory or recorded boundaries, and the scalar sweep of the earlier laptop study was not repeated.
- The discovery counts, refusals and the adversarial controls are in `affine-summary.md` and the unit tests; the rig run repeats the adversarial control for the scalar route (exact mode falls back at chunk 3, audit mode with two sampled chunks is wrong in 6 of 7 seeds).
- The shared-input stage shows the copy in `TaskPool.submit` is a large share of the explicit route's loss on xxHash and Adler-32. What remains for xxHash is not isolated; the per-task page compare in the checkpoint restore is the candidate.
