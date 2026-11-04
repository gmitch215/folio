# One-Pass Summary on arm64

Question: do the figures of the [one-pass summary study](../summary-onepass/README.md) hold on a second architecture?

## Setup

Same kernel, module and arms as the first study (`stream.wasm` is the same file, SHA256 `6e92da8161fc2b96d2874362e7e33e71ddecdc8d98100d31e9636badb122bcfe`). The 24 cells are fresh processes, one per session, input size (8 and 64 MiB) and worker count (1, 2, 4 and 8), each with 2 warmup rounds and 5 measured rounds. They ran on an Apple M2 Pro (12 cores) under macOS with Node 26.8.2, through `scripts/research/summary-onepass.sh`, which runs cells unpinned at `nice -n 19` when `taskset` is missing. macOS offers no core pinning, so the eight-worker cells may share performance and efficiency cores with other processes.

The machine was not quiet. The one-minute load average before a cell was 3.78 to 5.08, from other processes on the machine. The three sessions ran back to back on 2026-11-04 (UTC), starting at 03:44:55Z. Every cell exited with status 0, and every arm in every round returned the serial state.

## Results

Speedup over the serial run of the same round, with CPU time over serial CPU time in parentheses, median over 3 sessions. The Ryzen rows are from the first study.

| Cell | Machine | One-pass shared | One-pass copied | Two-pass shared |
| --- | --- | --- | --- | --- |
| 64 MiB, 4 workers | M2 Pro | 3.91x (1.02) | 3.52x (1.09) | 1.96x (1.53) |
| 64 MiB, 4 workers | Ryzen | 3.91x (1.01) | 3.00x (1.23) | 1.97x (1.52) |
| 64 MiB, 8 workers | M2 Pro | 7.00x (1.04) | 5.69x (1.18) | 3.77x (1.80) |
| 64 MiB, 8 workers | Ryzen | 6.41x (1.03) | 4.22x (1.18) | 3.41x (1.79) |
| 8 MiB, 8 workers | M2 Pro | 6.31x (1.08) | 5.20x (1.15) | 3.65x (1.84) |
| 8 MiB, 8 workers | Ryzen | 3.95x (1.08) | 3.47x (1.18) | 2.49x (1.87) |

The ordering of the arms and the CPU ratios match the Ryzen: the shared one-pass arm uses 1.01 to 1.08 times the serial CPU time in every cell, the copied arm 1.05 to 1.18 and the two-pass arm about 1.5 to 1.8 at four and eight workers. The eight-worker one-pass shared result at 64 MiB ranges from 6.75x to 7.18x across the sessions, narrower than the Ryzen's 5.14x to 7.68x. At 8 MiB the range is 5.73x to 6.45x. The serial kernel ran at 152 to 154 MB/s, about half the Ryzen's 300 MB/s. The kernel is one bitwise CRC-32C, so these figures stay a best case for scaling, and the load average above means they are directional.

## Reproduction

The module is `../summary-onepass/stream.wasm`. From the repository root on macOS:

```sh
FOLIO_RIG_NODE=/path/to/node bash scripts/research/summary-onepass.sh stream.wasm out
node scripts/research/summary-onepass-table.mjs out cells-summary.json
```

## Artifacts

- `cells/`: the 24 cell records, one per session, size and worker count.
- `summary.json`: the output of `summary-onepass-table.mjs` over `cells/`.
- `progress.log`: the exit status of each cell in run order.
- `manifest.json`: byte lengths and SHA256 digests.
