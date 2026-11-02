# Explicit Route Copy Cost

Question: why does the explicit route with private contexts stay below 1.0 on xxHash, Adler-32 and LZ4 decompress, and does a route that keeps the records in place reach 1.0?

## Method

`scripts/research/c21-shared.sh` runs the explicit arm of the corpus bulk drivers for five programs at 64, 512 and 4,096 records, eight workers, three sessions of five rounds after two warmups, one fresh process per cell, on the Ryzen 9 9900X under the timing lock (`nice 19`, CPUs 4 to 11, governor `powersave`). Four variants:

| variant | what changes |
| --- | --- |
| `copy` | the default: `TaskPool.submit` copies each task's `SharedArrayBuffer` input |
| `shared` | `{ share: true }` posts the input without a copy |
| `skip` | shared input, and `InstanceCheckpoint.restore` skips the ranges `writeRecords` sets (`C21_OVERWRITE=1`) |
| `inplace` | no private context: one shared memory holds the records, the caller declares them independent, each worker instantiates the unmodified module on that memory with its own 64 KiB stack and runs a slice of the bulk entry (`C21_ARMS=inplace`, `c21-inplace-worker.ts`) |

The workers time their restore, record write, kernel and output copy per task, and the table sums them over workers. `copy-bandwidth.mjs` copies 64 MiB four times per thread from a shared buffer into a wasm memory with 1, 2, 4 and 8 threads at once (`copy-bandwidth.txt`). `raw.tar.gz` holds every raw row and session log; the `inplace` xxHash3 cells ran in a second pass because the first pass refused them (the module has a stack pointer global, and the guard in the arm stops a shared stack), and the first pass's empty files are not kept. Every sample equals the serial output.

## Results

Speedup over the serial program, median of the session medians (range over sessions in `summary.md`):

| program | records | copy | shared | skip | inplace |
| --- | ---: | ---: | ---: | ---: | ---: |
| xxHash32 | 4,096 | 0.22 | 0.53 | 0.92 | 3.59 |
| xxHash64 | 4,096 | 0.11 | 0.29 | 0.50 | 2.20 |
| xxHash3 | 4,096 | 0.17 | 0.42 | 0.72 | 2.94 |
| Adler-32 | 4,096 | 0.56 | 1.34 | 2.15 | 4.94 |
| LZ4 decompress | 4,096 | 0.48 | 0.48 | 0.55 | 3.20 |

At 4,096 records of 128 KiB (512 MiB), xxHash32 workers spend 219 ms summed in the record write and 55 ms in the kernel once the restore is skipped. The copy moves 17.3 GB/s with one thread and 17.8 GB/s with eight, so it does not scale with workers, and native xxHash32 reads the same data at about 14 GB/s (xxHash64 about 26 GB/s). A route that copies first cannot beat serial on these kernels, and the kernels themselves scale when they read in place, so the limit is the copy and not their read bandwidth. The in-place route has no copy and reaches 1.7x to 4.9x across all five programs and three sizes.

## Scope

- One machine, one input stream per size. The in-place arm is a research arm, the independence is declared and not tracked, and it refuses a module with a mutable global other than the stack pointer, and runs a config block's setup once through the pool. A program that writes shared statics would fail the output check.
- LZ4 decompress is dominated by the output-side restore and the copy of outputs to the owner, which the `skip` variant does not touch.
- The phase table is per round, summed over workers; it is not a critical-path breakdown.
