# One-Pass Summary Repeat

Question: do the figures of the [one-pass summary study](../summary-onepass/README.md) repeat on the same rig on a later date, using the promoted scripts?

## Setup

Same kernel, same module and same arms. `stream.wasm` is byte-identical to the one in the first study (SHA256 `6e92da8161fc2b96d2874362e7e33e71ddecdc8d98100d31e9636badb122bcfe`). The 24 cells are fresh processes, one per session, size (8 and 64 MiB) and worker count (1, 2, 4 and 8), each with 2 warmup rounds and 5 measured rounds, run on the Ryzen rig (Ryzen 9 9900X, cores 4 to 11) with Node 26.10.0 under the timing lock, `nice -n 19` and `taskset -c 4-11`. The runner is `scripts/research/summary-onepass.sh` and the probe is `scripts/research/summary-probe.ts`, which skips the two-pass arm when the input is one chunk.

The first study started at 2026-11-03T20:09Z. This one started at 2026-11-04T02:44:35Z, 6.6 hours later and on the next UTC date. All 24 cells ran in 66 seconds, so the three sessions are back-to-back repeats and not samples from separate days. The one-minute load average before a cell was 0.06 to 1.18. Every cell exited with status 0 in its first pass, including the width-1 cells that failed in the first study. Every arm in every round returned the serial state.

## Results

Speedup over the serial run of the same round, with CPU time over serial CPU time in parentheses, median over 3 sessions.

| Cell | Run | One-pass shared | One-pass copied | Two-pass shared |
| --- | --- | --- | --- | --- |
| 64 MiB, 4 workers | repeat | 3.93x (1.01) | 3.02x (1.23) | 1.98x (1.51) |
| 64 MiB, 4 workers | first | 3.91x (1.01) | 3.00x (1.23) | 1.97x (1.52) |
| 64 MiB, 8 workers | repeat | 6.83x (1.03) | 4.69x (1.18) | 3.82x (1.79) |
| 64 MiB, 8 workers | first | 6.41x (1.03) | 4.22x (1.18) | 3.41x (1.79) |
| 8 MiB, 8 workers | repeat | 4.14x (1.07) | 3.47x (1.19) | 2.68x (1.86) |
| 8 MiB, 8 workers | first | 3.95x (1.08) | 3.47x (1.18) | 2.49x (1.87) |

The eight-worker one-pass shared result at 64 MiB ranges from 5.59x to 7.74x across the three sessions here and from 5.14x to 7.68x in the first study. At 8 MiB the range here is 3.93x to 6.31x, against 3.88x to 3.97x before. Every other one-pass shared cell has a range of 0.15x or less. The serial kernel ran at 300 to 303 MB/s, as in the first study. The CPU ratios match the first study to within 0.01 in every cell of the table. Across all 24 cells they differ by more than 0.01 only at one worker, by 0.02 for the copied arm at 8 MiB and by 0.03 for the shared arm at 64 MiB.

The repeat gives the same ordering of the arms and the same CPU ratios. It does not narrow the spread at eight workers, which is wide in both studies. The kernel is one bitwise CRC-32C on one machine, so these figures stay a best case for scaling.

## Reproduction

The module is `../summary-onepass/stream.wasm`. On the rig, from a checkout that has `node_modules`:

```sh
FOLIO_RIG_NODE=/path/to/node bash scripts/research/summary-onepass.sh stream.wasm out
node scripts/research/summary-onepass-table.mjs out cells-summary.json
```

## Artifacts

- `cells/`: the 24 cell records, one per session, size and worker count.
- `summary.json`: the output of `summary-onepass-table.mjs` over `cells/`.
- `progress.log`: the exit status of each cell in run order.
- `manifest.json`: byte lengths and SHA256 digests.
