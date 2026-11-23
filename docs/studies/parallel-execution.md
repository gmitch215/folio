# Parallel Execution

Folio runs native WebAssembly across several V8 isolates over one physical memory allocation. This page covers what the measurements found about scaling, the explicit pools, the certified routes and the router, including the gates that were set in advance and not met.

## Question

When does running a Wasm program on several isolates beat the serial program, which routes keep the serial result, and does automatic discovery of independent work help on programs Folio did not shape?

## Instruments

| Study                                                                                                                           | What it measures                                            | Where                    |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------ |
| [sharing](https://github.com/gmitch215/folio/blob/master/results/memory/sharing/README.md)                                      | resident memory of shared against copied buffers            | Node 26.10.0             |
| [scaling](https://github.com/gmitch215/folio/blob/master/results/execution/scaling/README.md)                                   | one unannotated entry on 1 to 8 workers                     | Ryzen rig                |
| [placement](https://github.com/gmitch215/folio/blob/master/results/execution/placement/README.md)                               | pinned against unpinned workers on normally inlined C       | Ryzen rig                |
| [reset-policies](https://github.com/gmitch215/folio/blob/master/results/corpus/reset-policies/README.md)                        | the reset between explicit tasks on 21 kernels              | Ryzen and M2 Pro         |
| [slice-pool-census](https://github.com/gmitch215/folio/blob/master/results/corpus/slice-pool-census/README.md)                  | 30 record-level drivers through `SlicePool`                 | Ryzen rig, quiet         |
| [stream-certifier](https://github.com/gmitch215/folio/blob/master/results/certification/stream-certifier/README.md)             | the proof that a stream function is an affine fold          | Ryzen rig                |
| [ownership-slice-gates](https://github.com/gmitch215/folio/blob/master/results/execution/ownership-slice-gates/README.md)       | the six ownership certificates on the slice route           | Mac and rig              |
| [router-development-sweep](https://github.com/gmitch215/folio/blob/master/results/execution/router-development-sweep/README.md) | the router over 38 development drivers                      | Ryzen rig, quiet         |
| [final-evaluation](https://github.com/gmitch215/folio/blob/master/results/execution/final-evaluation/README.md)                 | the router on 47 frozen final drivers, pre-registered gates | x86_64 rig and arm64 Mac |
| [external-applications](https://github.com/gmitch215/folio/blob/master/results/execution/external-applications/README.md)       | three unmodified outside programs                           | Ryzen rig                |

Timing comes from an AMD Ryzen 9 9900X and an Apple M2 Pro. Speedup is the median over rounds of the paired ratio serial time over arm time. A claim about speed needs raw samples under `results/` and the instrument named.

## Design

| Route                 | Who names the independence | What it checks                                                                                      |
| --------------------- | -------------------------- | --------------------------------------------------------------------------------------------------- |
| Iteration route       | nobody; Folio finds loops  | every iteration's reads and writes at 64 B and 32 B granules, in order, with an undo log and replay |
| Task pool             | the caller                 | nothing by default; `audit` reruns every nth task serially and compares the output bytes            |
| Slice pool            | the caller                 | nothing by default; `audit: true` replays every slice serially on a copy                            |
| Certified stream fold | a proof                    | the certificate holds for every length and split of the module                                      |
| Ownership slice route | a proof, with premises     | six obligations of the certificate; the premises are not proved                                     |
| Router                | the certificates           | picks one of the routes above per call, or native serial                                            |

The router chooses in a fixed order: certified summary, certified private window in place, an explicit runner, tracked speculation where its assumptions hold, and native serial otherwise.

## Results

### Sharing and Scaling

Four isolates over a touched 64 MiB backing add 3.871 MiB of resident memory, against 259.930 MiB for copied buffers.

The scaling sweep used one unannotated C entry, one shared arena and a serial oracle, with CPU affinity across eight distinct physical cores. All 207 samples compare the complete 268,500,992-byte allocation exactly, and none was discarded.

| Compute: 4,096 words, 32,768 mixes | Elapsed median | Paired speedup [range] | Total CPU ratio |
| ---------------------------------- | -------------: | ---------------------: | --------------: |
| Untouched serial                   |     150.706 ms |                      1 |               1 |
| Two native workers                 |      76.191 ms | 1.976 [1.952 to 1.987] |           1.009 |
| Four native workers                |      38.591 ms | 3.903 [3.892 to 3.932] |           1.017 |
| Eight native workers               |      19.780 ms | 7.619 [7.525 to 7.705] |           1.037 |
| Four tracked workers               |      41.398 ms | 3.640 [3.550 to 3.661] |           1.070 |

| Streaming 256 MiB, one mix per word | Elapsed median | Paired speedup | Total CPU ratio |
| ----------------------------------- | -------------: | -------------: | --------------: |
| Untouched serial                    |      38.777 ms |              1 |               1 |
| Two workers                         |      20.415 ms |          1.898 |           1.040 |
| Four workers                        |      11.096 ms |          3.497 |           1.097 |
| Eight workers                       |      11.166 ms |          3.474 |           1.791 |

Eight workers did about the same computation in one eighth of the time and did not reduce total CPU work. Compute scales to eight while streaming stops near four, which fits a shared memory system or cache contention, but no bandwidth or stall counters were collected. Normally inlined C with automatic region discovery reads 7.519x at eight pinned workers and 5.636x unpinned ([placement](https://github.com/gmitch215/folio/blob/master/results/execution/placement/README.md)). A 4,096-word stream took 0.01089 ms raw, 0.02490 ms through the pool's automatic serial route and 3.47807 ms with forced tracking, so tiny jobs lose to dispatch overhead.

### Automatic Extraction on Programs Folio Did Not Shape

On 21 library kernels from nine projects, default admission dispatches no worker, and forced admission makes all 11 kernels that receive regions 108 to 45,645 times slower. On three unmodified outside programs built at `-O2` and run as one call of `main`, the pass line was a paired speedup of at least 1.20 with an interval above 1.0.

| Program           | Route taken                  | Paired speedup (interval) | Wrong outputs                                    |
| ----------------- | ---------------------------- | ------------------------- | ------------------------------------------------ |
| aobench           | serial, `unsupported-module` | 1.002 (0.999 to 1.007)    | 0 in 126 timed samples across the three programs |
| 6pack with FastLZ | serial, `unsupported-module` | 1.002 (0.996 to 1.004)    |                                                  |
| llama2.c          | serial, `unsupported-module` | 1.001 (0.998 to 1.003)    |                                                  |

The pass line is not met. No region reaches the 200,000-unit admission threshold, and the iteration route refuses all three because the hot loops nest inside one function or inline into a larger one. This closes automatic discovery on unmodified `-O2` builds of these three programs.

The iteration route does find one loop shape in an outside program. On BLAKE3 over several inputs it reaches 2.0x to 3.1x under default admission on the Ryzen machine and 2.8x to 3.5x on the M2 Pro, against 1.00x without it. SHA-256 gains 1.7x to 2.1x with the per-input work in a helper, and LZ4 gains nothing (0.87x to 0.99x) because its output exceeds the undo log.

### Explicit Pools

A caller-named boundary with private contexts speeds up all 21 kernels at least slightly, and 18 of 21 by 2x or more on eight batched `TaskPool` workers with learned-page reset. With the checkpoint reset, 8 of 21 reach 2x. Eight batched workers, speedup over native and process CPU as a ratio of native CPU:

| Kernel          | Machine |       `whole` |      `pages` | `checkpoint` |
| --------------- | ------- | ------------: | -----------: | -----------: |
| AES-CBC decrypt | Ryzen   |  3.19x / 1.97 | 4.80x / 1.05 | 4.52x / 1.30 |
| SHA-256         | Ryzen   |  0.92x / 5.93 | 3.79x / 1.10 | 2.52x / 2.35 |
| LZ4 compress    | Ryzen   | 0.44x / 12.67 | 3.11x / 1.52 | 1.14x / 4.59 |
| xxHash32        | Ryzen   | 0.43x / 12.62 | 2.48x / 1.80 | 1.40x / 3.93 |

The eight-worker arm varies by up to 1.5x between runs of the same machine. In the held-out set of eight drivers from six new projects, explicit private contexts win all 8 (1.94x to 3.96x, every output equal to serial), automatic admission wins 1 and the slice pool is exact on 2.

The slice pool, where the caller declares the records independent, was run on 30 drivers at eight workers, three sessions of five rounds. Twenty run exact at 1.94x to 3.88x. Ten fail the output check in at least one session: miniz, the QOI drivers and the `-shared` variants, which are file-scope statics and allocator cursors. Four of the ten passed in some sessions and failed in others, which is what a race on shared state looks like. With `audit: true` the pool threw `SliceConflictError` on seven of eight failing drivers tried, agreed with the serial run on four passing drivers, and trapped on the eighth.

| Mode over the 30 loops (failed or inapplicable counted as serial) | Geometric mean speedup |
| ----------------------------------------------------------------- | ---------------------: |
| Automatic admission                                               |                   0.98 |
| Forced admission                                                  |                   0.56 |
| Explicit private contexts                                         |                   1.89 |
| Slice pool                                                        |                   2.10 |
| Best exact mode per loop                                          |                   2.72 |

The same drivers compiled natively with a parallel-for over the records reach 3.46x geometric mean with output equal to serial on 37 of 38 drivers. The best exact Wasm mode per driver reaches 2.80x, which is 0.81 of native. The native code has no sandbox, bounds checks or linear memory, so it is an upper reference.

### Certification

`certifyStream` proves from the module bytes that `entry(state, ptr, len)` is the left fold of one affine byte step for every length and split. Fourteen compiled subjects were run with ground truth from execution at lengths from 1 byte to 1 MiB.

| Result                                                           | Count or figure                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Valid compiled subjects certified                                | 7 (CRC-32C, CRC-16, CRC-64, a hash, an LCG, miniz CRC-32, Adler-32 over two residues) |
| Kernels that rewrite their input in place, certified             | 4                                                                                     |
| Split-sensitive constructed modules refused                      | all 14                                                                                |
| In-class valid red-team modules certified                        | 506 of 519                                                                            |
| Certificates that disagree with execution after the fixes        | none in 1,096 red-team modules or 3,492 round-three modules                           |
| Refused                                                          | FNV-1a and the SHA-256 compression function                                           |
| False certificates found by two adversary rounds and two reviews | one in each, all fixed                                                                |

One pass on shared memory at eight workers reads 3.4x to 4.1x at 8 MiB and 4.7x to 6.8x at 64 MiB at a CPU ratio of 1.02 to 1.10, with wide ranges between sessions. The checker is not formally verified, its ground truth is sampled execution, and both reviewers share the author's model family.

The ownership certificate treats a driver as a proof with six obligations. The locked gate was 8 of the 10 failing development drivers certified, and the result is 6 of 10, so the gate is NOT MET. Each of the six passes the slice route's gate over widths 1, 2, 4 and 8 with trapping records included: 72 of 72, 72 of 72, 72 of 72, 108 of 108, 84 of 84 and 84 of 84 runs equal to serial, and a negative control that empties the copy-out differs for all six. On `aes-cbc-decrypt-shared`, 256 records, 15 paired rounds, eight workers read 4.07x with six CPUs and 5.64x with ten. That is one driver. The redirect route on the iteration pool does not pay on the same module (0.76x with six CPUs and 1.10x with ten at eight workers).

### The Router

The router's gates were pre-registered, and the final corpus was drawn once before any Folio run on it: 47 drivers from 10 projects, three sessions of ten rounds on an x86_64 rig and three on an arm64 Mac, 17,484 rows.

| Measure                                      | x86_64                               | arm64                       | Gate |
| -------------------------------------------- | ------------------------------------ | --------------------------- | ---- |
| Gate 1: geometric mean of 47 router speedups | 0.899 (sessions 0.897, 0.900, 0.900) | 0.900 (0.894, 0.906, 0.898) | 1.20 |
| Gate 2: slowest of the five slowest drivers  | 0.594                                | 0.561                       | 0.90 |
| Bootstrap interval of the geomean            | 0.861 to 0.935                       | 0.858 to 0.941              |      |
| Probability of reaching 1.20                 | 0.00                                 | 0.00                        |      |

Gate 3 is met, with 0 wrong outputs in 17,484 rows. Gates 1 and 2 are not met on either architecture in any session. The router ran serial for 46 of 47 drivers on both architectures: 23 refused as `unclassified-dependency` and 23 below the route floor. The one window certificate, `minimp3-mp3dec_init`, ran the window route in 21 of 30 arm64 rounds and in none on x86_64. 41 drivers read below 1.00 on x86_64 and 42 on arm64, led by drivers whose serial call takes 0.002 to 0.04 ms. The study did not examine the cause of the serial-path overhead.

On the 38 development drivers the router's geomean was 1.209 with a driver-level bootstrap interval of 1.068 to 1.395, and the probability of reaching 1.20 was 0.52. The margin rested on a few drivers: without `qoa-encode` it is 1.182. Those drivers were also the data the router constants were fitted on, so that figure did not carry over to the frozen corpus.

Pooled geomean per mode, x86_64 then arm64: serial 1.000 (control), `w1` 0.895 and 0.905, `w2` 0.910 and 0.902, `independent` 0.908 and 0.903, `shared` 0.857 and 0.875, `router` 0.899 and 0.900.

## Reading

Speedups come from boundaries that someone names or proves. A single call with automatic extraction does not gain on library kernels or on three outside programs. Explicit private contexts reach 2x or more on most kernels, at a reset cost that depends on the policy. The slice pool and the certified fold avoid the reset or the check, at the price of a declaration or a proof. The router's value on the final corpus is that it kept every output equal to serial. It did not speed anything up there, because it ran serial on 46 of 47 drivers.

The classes that do not benefit are calls whose serial time is under about 0.05 ms, programs whose records share an allocator or statics, loops whose output exceeds the undo log, and one uncached PHP render.

## Closed and Open

Closed mechanisms: existing region extraction on single calls of the 21 kernels, forced admission, a gate fitted on the 30 drivers (it failed on the held-out set), coarsening, windows, the summary and second chance for the five xxHash and Adler-32 drivers, and automatic discovery on the three outside programs.

Open: a full application, automatic discovery of independent task boundaries, other loop shapes and programs, iterations of unequal size, a third measurement machine, and review of the harnesses and claims by anyone outside the author's model family. The ownership certificates are tested by three red team rounds and a re-audit and are not proved. The final corpus is a development set after any change to Folio.

## See Also

- Report: [Router and Development Ablation](../../TECHNICAL_REPORT.md#router-and-development-ablation), [Final Corpus and Baselines](../../TECHNICAL_REPORT.md#final-corpus-and-baselines), [Certified Stream Folds](../../TECHNICAL_REPORT.md#certified-stream-folds), [Ownership Certificate and the Slice Route](../../TECHNICAL_REPORT.md#ownership-certificate-and-the-slice-route)
- Modules: [Pools](../modules/pools.md), [Folds and Certificates](../modules/folds-and-certificates.md), [Core](../modules/core.md)
- Related study: [Memory Accounting](memory-accounting.md)
