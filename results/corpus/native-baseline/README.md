# Native Baseline

Question: how far are the WebAssembly routes from the obvious source-level parallelization of the same library entries, a parallel-for over the records with native threads?

## Method

`scripts/research/native-bulk.c` compiles each of the 38 bulk drivers natively with the system clang (18.1.3, `-O2 -DNDEBUG`, no `-march`, system libc) from the same library sources, the same `K_` define and the same project flags as the wasm build, with the unmodified `cases/c21/bulk.c` (its record table widened to native pointers by a one-line rewrite). A persistent pool of eight threads splits the record range exactly as `SlicePool` does (contiguous slices of ceil(n / 8) records), and each slice calls the driver's `bulk` on its range. The library's allocator calls go to a copy of the wasm bump allocator with thread-local state and one arena per slice. The three drivers that keep scratch in file-scope statics (`jsmn-parse-shared`, `aes-cbc-decrypt-shared`, `sha256-shared`) are built with that scratch thread-local, so they are parallelized with a per-thread copy. `kissfft-real-shared` keeps a scratch buffer inside the shared config block, which is a data race by the library's design, and its output differs. Every parallel output is compared slot by slot with the serial output of the same process.

The timing is one process per driver and session on the Ryzen 9 9900X under the timing lock (`nice 19`, CPUs 4 to 11, eight threads), serial and parallel alternated each round, median of five rounds after two warmups, three sessions. `native.md` is the table, `comparison.md` joins it with the best exact wasm mode per driver from `../record-level-rig`, `../slice-pool-census` and `../held-out-workloads`, `raw.tar.gz` holds every row and log.

## Results

Native parallel-for output equals serial on 37 of 38 drivers (all but `kissfft-real-shared`). Over those 37 the geometric mean speedup is 3.46x and 36 are above 2x; the best exact wasm mode per driver (automatic, forced, explicit private contexts or the slice pool, whichever is highest and exact) has a geometric mean of 2.80x and 31 above 2x, which is 0.81 of the native figure. The wasm routes are ahead of native threads on a few drivers whose records are tiny, where thread hand-off dominates (wyhash: 3.12x in place against 1.44x native), and behind it on the digests with large records (xxHash64 1.94x against 6.39x, xxHash3 2.69x against 4.48x, BLAKE2 3.46x against 5.61x, SHA-256 3.43x against 5.43x). The difference on a driver is the route's overhead against a native thread with no memory tracking, no private context copy and a native-speed kernel.

## Scope

- One machine, eight threads, one record stream per driver. The native code has no wasm sandbox, bounds checks or linear memory, so it is an upper reference and not a like-for-like route.
- "Best wasm mode" takes the highest of up to four arms per driver, which flatters wasm; the in-place and explicit arms need a caller declaration that native parallel-for also needs.
- The `jsmn-parse-shared`, `aes-cbc-decrypt-shared` and `sha256-shared` rows use a thread-local copy of scratch the wasm drivers share, so those rows are not the same program.
- No source-level parallel mode of a library itself (a library's own threaded API) was run.
