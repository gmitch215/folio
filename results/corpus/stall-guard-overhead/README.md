# Stall Guard Overhead

Question: what does the stall guard (`iterationStall`) cost a loop that never stalls, on a quiet machine?

## Method

`scripts/research/stall-overhead.ts` opens the same iteration route twice, once without the stop poll and once with it, and runs both on the same inputs in alternating order: 40 measured rounds after one warmup, 32 inputs per run, width 2 and width 4. Every row's digest equals the serial run's, and no row replays or stalls. The metric is `workerRunMs`, the worker time the pool reports, and the wall time of the run is beside it.

The machine is the Ryzen 9 9900X under the timing lock with `nice 19` and CPUs 4 to 11 (machine load 0.3 to 1.5 during the runs). The BLAKE3 and SHA-256 modules are the consumer builds in `../blake3-consumer/` and `../sha256-consumer/` (the SHA-256 helper build). `crc32.wasm` and `md5.wasm` are built from `kernels.c`, one helper call per input.

## Results

Ratio of the median with the guard on to the median with it off.

| kernel                  | worker time, width 2 | worker time, width 4 | wall, width 2 | wall, width 4 |
| ----------------------- | -------------------- | -------------------- | ------------- | ------------- |
| BLAKE3, 32 x 1 MiB      | 1.012                | 1.009                | 1.008         | 1.004         |
| SHA-256, 32 x 1 MiB     | 1.062                | 1.067                | 1.051         | 1.041         |
| CRC-32, 32 x 4 MiB      | 1.049                | 1.046                | 1.024         | 1.014         |
| MD5, 32 x 1 MiB         | 1.112                | 1.083                | 1.074         | 1.033         |

The rule written before the run was to turn the guard on by default if the median worker-time overhead stayed at or under 5% on all four. SHA-256 (6.2% to 6.7%) and MD5 (8.3% to 11.2%) are over it, so the guard stays opt-in. `summary.jsonl` holds the min and median of every cell, and `rig.tar.gz` the 640 raw rows.

## Scope

- One machine, four kernels, two widths. Tight loops with short bodies (MD5's round loop, SHA-256's compression loop) pay the most, because the poll is a load and a branch at every loop start.
- The guard cannot be armed after a stall, since the poll has to be in the lowered code.
