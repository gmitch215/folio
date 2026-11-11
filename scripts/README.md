# `scripts/`

The folder decides the runtime.

| where               | what                                                                                                           | runtime                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `scripts/build/`    | C fixture compilation and prepared-plan generation                                                             | Bun, also runs under Node |
| `scripts/analyze/`  | deterministic summaries of the raw samples in `results/`                                                       | Bun, also runs under Node |
| `scripts/probe/`    | measurement instruments that need real `worker_threads` and V8                                                 | Node 26                   |
| `scripts/rig/`      | the timing rig on the Ryzen machine (`taskset`, `nice`, a lock)                                                | Bash                      |
| `scripts/research/` | the corpus, reset, crossover, iteration and differential studies, and the tools that summarize and verify them | Node 26, Bash             |

Everything outside `probe/` and `rig/` is TypeScript and uses `import.meta.main`, so
`bun scripts/build/fixtures.ts` and `node scripts/build/fixtures.ts` both work.

## Build

`fixtures.ts` compiles `tests/c/*.c` to `build/*.wasm` with the freestanding LLVM flags the
measurements used. `LLVM` points at a toolchain directory, and Homebrew's LLVM is the default on
macOS. The compiler runs with `node_modules/.bin` removed from `PATH`: binaryen installs a
`wasm-opt` there, clang runs it after linking when it finds one, and `bun run` adds that directory
to `PATH`. With it, `generalized.wasm` is 458 bytes. Without it, the result is the 511-byte
artifact the evidence names.

`prepare.ts` runs the compiler over `fixture.wasm` and `generalized.wasm` and writes
`build/probe.json` and `build/control-prepared.json`, which the probes read.

## Analyze

`bun scripts/analyze/run.ts` regenerates every `results/*/summary.json` from its raw `.jsonl`.
Each analyzer also takes a set name: `bun scripts/analyze/control.ts execution/control`. The
outputs match the summaries recorded on the Ryzen rig byte for byte, with one exception:
`results/memory/sharing/summary.json` lists its input files in sorted order, because directory
listing order differed between the two machines.

## Research

`scripts/research/` holds the studies behind the Independent Corpus and boot image sections of `TECHNICAL_REPORT.md`. Every
harness writes a new `raw.jsonl` and refuses to overwrite an existing one. Each raw file starts with
an environment record that names the runtime, hardware and a SHA256 of every source file it ran.

| file                                                                                                                                       | what it does                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corpus.ts`, `cases/`                                                                                                                      | builds the 21 pinned upstream kernels and checks them against native                                                                                                                                            |
| `corpus-serial.ts`, `admission-diagnostic.ts`                                                                                              | single-entry native against Folio; the threshold-zero diagnostic, one process per case                                                                                                                          |
| `corpus-mechanisms.ts`                                                                                                                     | explicit tasks against conventional workers with a `whole`, `pages` or `checkpoint` reset (`FOLIO_CORPUS_RESET`)                                                                                                |
| `inputs.ts`                                                                                                                                | five input profiles per kernel on persistent contexts against fresh native instances                                                                                                                            |
| `boot-eligibility.ts`                                                                                                                      | initialization, image restore and an application cache on the corpus initializers                                                                                                                               |
| `grain-build.ts`, `grain-diff.ts`, `grain-bench.ts`, `grain-summarize.ts`, `grain.sh`                                                      | the single-call AES grain kernel (`cases/aes-grain.c`), its equality check and its paired timing on the explicit route                                                                                          |
| `blake3-build.ts`, `blake3-bench.ts`, `blake3-worker.ts`, `blake3.sh`                                                                      | the pinned BLAKE3 consumer (`cases/blake3-hash-all.c`): build with the official vector check, then default, explicit and forced arms                                                                            |
| `lz4-build.ts`, `lz4-bench.ts`, `lz4.sh`                                                                                                   | the pinned LZ4 consumer (`cases/lz4-compress-all.c`) in its spec shape and as fixed-slot variants, with the default and automatic arms                                                                          |
| `sha256-build.ts`, `sha256-bench.ts`, `sha256.sh`                                                                                          | the pinned SHA-256 consumer (`cases/sha256-hash-all.c`) as a plain loop and with a helper per input, checked against Node's digests                                                                             |
| `affine-build.ts`, `affine-bench.ts`, `affine-worker.ts`, `affine-summary.ts`, `cases/affine/`                                             | the kernels and controls for `src/affine.ts`: discovery cost, and serial, exact, audit and hand-derived combine timings                                                                                         |
| `affine-state-build.ts`, `affine-state-bench.ts`, `affine-context-worker.ts`, `affine-state-summary.ts`, `cases/affine/context-subjects.c` | the context-struct subjects and corpus entries for `src/affine-state.ts` and `src/boundaries.ts`: state discovery, state-in-memory exact timings, recorded boundary verification                                |
| `sweeps-*.ts`, `cases/sweeps/`                                                                                                             | fixed-point sweeps over explicit-state chunks: sweep and chunk-run counts, boundary state sets, and pooled wall against serial                                                                                  |
| `stream-check.ts`, `loop-check.ts`                                                                                                         | the spike checkers: a transition step in a template wrapper, and one inline loop with a conditioning pair; each returns a GF(2) model or refuses                                                                |
| `split-sensitivity.ts`                                                                                                                     | 21 constructed modules against the probe, exact mode and the spike stream checker; takes the output path                                                                                                        |
| `loop-census.ts`, `class-census.ts`                                                                                                        | the spike loop checker and an operation census over the nine real subjects, with two negative controls; take the output path                                                                                    |
| `redteam/run.ts`, `redteam/*.ts`, `cases/redteam/*.c`                                                                                      | the checker red team: generators, ground truth, both spike checkers, merge and counts over an output directory; the second ground truth, the 1 MiB check and two timed fuzzers run separately                   |
| `footprint-probe.ts`, `footprint-extra.ts`                                                                                                 | serial write sets of every built bulk driver: shared bytes, carried state, stack shift, poison, input diversity, relocation, six synthetic adversary drivers                                                    |
| `summary-certify.ts`, `summary-compiled.ts`, `summary-probe.ts`, `summary-onepass.sh`, `summary-onepass-table.mjs`                         | build and check the compiled CRC-32C stream module, then time one-pass shared, one-pass copied, two-pass and serial arms on the rig and tabulate the cells                                                      |
| `summary-coldstart.ts`, `summary-breakeven-table.mjs`                                                                                      | time probe, checker, pool start, first and steady calls of the summary route, and print the calls needed to repay them                                                                                          |
| `certify-subjects.ts`, `certify-redteam.ts`, `certify-ground.ts`                                                                           | the stream certifier on the real subjects and the 21 constructed modules, and over a red-team run directory, each certificate checked by execution (`certify-ground.ts`)                                        |
| `adversary/gen-clang.ts`, `adversary/gen-wat.ts`, `adversary/compare.ts`                                                                   | the second-round adversary modules: 60 C kernels with mutants and the WAT families, written under a work directory, and a digest comparison with `adversary-modules.json`                                       |
| `adversary/run.ts`, `adversary/one.ts`, `adversary/summarize.ts`, `adversary/select-final.ts`, `adversary/summary-final.ts`                | certify and judge every generated module in sharded child processes with a 90 s limit, then merge the counts and the final selection; `adversary/lib.ts` holds the ground truth                                 |
| `adversary/fuzz-locals.ts`, `adversary/fuzz-trips.ts`, `adversary/robust-atoms.ts`, `adversary/robust-store.ts`                            | the reviewer's differential fuzzers over loop summaries and trip counts, and two timed denial-of-service modules; the fuzzers exit 1 on a wrong acceptance                                                      |
| `adversary/fuzz-residues.ts`                                                                                                               | random modular checksum kernels with two residues in the state, one hazard each, checked against execution; exits 1 on a wrong acceptance                                                                       |
| `adversary/fuzz-residue-atoms.ts`, `adversary/fuzz-output.ts`, `adversary/zero-run.ts`                                                     | random residue and whole-state byte steps with nonlinear atoms, random in-place streams, and step-only kernels against the `zeroRun` doubling; each exits 1 on a wrong acceptance or a mismatch                 |
| `adversary/round3/gen-m.ts`, `gen-r.ts`, `gen-x.ts`, `gen-y.ts`, `specs-c.ts`, `specs-w.ts`, `specs.ts`                                    | the third-round adversary modules: mutants of 30 base modules, random kernels, offset immediate attacks, wide-state kernels and the written C and WAT families, 3,492 distinct modules under `ROUND3_OUT`       |
| `adversary/round3/digests.ts`, `run.ts`, `eval-worker.ts`, `recheck.ts`, `summarize.ts`                                                    | build every module and compare digests with a manifest, certify and check each in worker threads with a time limit, recheck pointer placements, count the rows and write `modules.json`                         |
| `adversary/round3/recert.ts`, `control.ts`, `repro-offset.ts`                                                                              | recertify every module of a manifest with the current checker and count the verdict transitions, negative controls for the ground truth, and the two offset immediate modules that trap                         |
| `certify-cost.ts`, `certify-cost.sh`, `certify-cost-table.mjs`                                                                             | certification, share, first call and steady calls of the certified route on shared memory (kernels that rewrite their input run through `reconstructCertified`), one process per cell, and the break-even table |
| `certify-verify.ts`, `certify-verify-run.ts`, `certify-counts.ts`                                                                          | stream certificate verifier, run by hand: `certify-verify-run.ts subjects`, `mutants [NAME...]` or `redteam DIR SHARD COUNT [full] [EVERY]` (not in the gate); `certify-counts.ts` for the three counts         |
| `certified-worker.ts`                                                                                                                      | worker entry for `serveCertified` in `src/certified.ts`: a shared-import instance that reads the input in place                                                                                                 |
| `admission-quality.mjs`                                                                                                                    | scores automatic admission against the measured modes of a record-level run: confusion matrix, regret, a gate fitted on a split, and a gate fixed beforehand (`AQ_GATE`)                                        |
| `static-footprint.mjs`                                                                                                                     | counts constant-address stores, global writes, indirect calls and imported calls in each driver module                                                                                                          |
| `size-change.ts`, `size-change-table.mjs`                                                                                                  | one pool, one program, calls whose record sizes change; the table gives the speedup and mode of each call                                                                                                       |
| `native-bulk.c`, `native-bulk.sh`, `native-bulk-export.ts`, `native-bulk-arms.sh`, `native-bulk-table.mjs`                                 | the bulk drivers compiled natively with a parallel-for over the records (the source-level baseline), with a serial check of every output                                                                        |
| `plan-snapshot.ts`                                                                                                                         | dumps the stable `prepare` plan fields of every fixture and corpus artifact for a root, with the route summaries beside it                                                                                      |
| `inline-diff.ts`                                                                                                                           | the inline tracking lowering against native, the host-call footprint and binaryen's tracer; `cost` times the BLAKE3 consumer                                                                                    |
| `iteration-diff.ts`                                                                                                                        | the iteration executor against the serial program: random programs, and the BLAKE3 consumer (`blake3`, with a `Folio.run` arm)                                                                                  |
| `iteration-admission.ts`, `iteration-admission.sh`                                                                                         | the admission sweep on the BLAKE3 consumer; `summary` flags every wrong decision                                                                                                                                |
| `focused.ts`                                                                                                                               | eight-worker repeats with one active pool at a time, a paired serial control and an idle-pool condition                                                                                                         |
| `crossover.ts`, `graded.ts`                                                                                                                | synthetic compute, stream and conflict cells; graded conflict rates and adaptive routing                                                                                                                        |
| `differential.ts`                                                                                                                          | generated programs and guard-refusal loops against native at widths 1, 2, 4 and 8                                                                                                                               |
| `matched.sh`, `backing.sh`, `focused.sh`, `completion.sh`                                                                                  | run the studies in sequence on the Linux rig under a timing lock                                                                                                                                                |
| `analyze.ts`                                                                                                                               | paired summaries with bootstrap intervals from a raw file                                                                                                                                                       |
| `derive.ts`, `denominators.ts`                                                                                                             | blocker histogram, state-loss counts, session spread, operation costs, the corpus denominator table and the per-kernel table                                                                                    |
| `ownership-modules.ts`, `ownership-alloc-modules.ts`, `ownership-extent-modules.ts`                                                        | hand-written bulk, allocator and shim byte-loop modules that the ownership gates and adversaries certify                                                                                                        |
| `ownership-brotli-modules.ts`, `ownership-bytes-modules.ts`, `ownership-cap-modules.ts`                                                    | hand modules in the shape of brotli, tinfl byte fields and the md4c-html blockers (fill pieces and select arms)                                                                                                 |
| `ownership-dispatch-modules.ts`, `ownership-sentinel-modules.ts`, `ownership-stackidx-modules.ts`                                          | hand modules for a `br_table` loop, a sentinel-padded buffer and a stack array read at a bounded data index                                                                                                     |
| `ownership-yyjson-modules.ts`, `ownership-yyjson2-modules.ts`, `ownership-relational-modules.ts`                                           | hand modules for yyjson value arrays and utf-8 joins, and for the jsmn token table                                                                                                                              |
| `ownership-cursor-modules.ts`, `ownership-prefix-modules.ts`, `ownership-kissfft-modules.ts`                                               | hand modules for the qoi cursor, the prefix-written buffer and the kissfft config premise                                                                                                                       |
| `ownership-drivers.ts`                                                                                                                     | certifies the fixed-address and allocator drivers by id; `PREFIX=1`, `ALLOC=1` and `NO_PROBE=1` set the domain options and skip the probe                                                                       |
| `ownership-adversary.ts`                                                                                                                   | mutates hand modules and real drivers, certifies each mutant and compares the window route with serial; `alloc` runs the allocator mutants                                                                      |
| `ownership-alloc-adversary.ts`, `ownership-bytes-adversary.ts`, `ownership-cap-adversary.ts`, `ownership-stackidx-adversary.ts`            | text mutants of one module family, certified in allocator mode; each accepted mutant runs at two arena bases, at extreme lengths and on the slice route                                                         |
| `ownership-cursor-adversary.ts`, `ownership-extent-adversary.ts`, `ownership-kissfft-adversary.ts`                                         | text mutants of the cursor, extent and kissfft modules; each accepted mutant runs through the window or slice route against serial                                                                              |
| `ownership-prefix-adversary.ts`, `ownership-relational-adversary.ts`                                                                       | text mutants of the prefix buffer and the token table, run through the redirect and the in-place slice pool against serial                                                                                      |
| `ownership-slices-gate.ts`, `ownership-redirect-gate.ts`                                                                                   | certificate, then the in-place slice pool or the redirect route against serial; modes are `drivers`, `control` and `mutants` (the redirect gate has no `control`)                                               |
| `ownership-prefix-gate.ts`, `ownership-relational-gate.ts`, `ownership-cursor-gate.ts`, `ownership-kissfft-gate.ts`                        | one-driver gates for a driver certified with the prefix, relational, qoi or config-premise option; modes are `drivers`, `control` and, in some gates, `timing` or `premise`                                     |
| `ownership-slices-timing.ts`, `ownership-redirect-timing.ts`, `ownership-kissfft-timing.ts`                                                | paired rounds on the rig (`run ROUNDS OUT.jsonl`), each arm in a child process: serial, redirected, and the pool or slice arms                                                                                  |
| `ownership-redirect-rig.ts`, `ownership-slices-rig.ts`, `ownership-slices-imports.ts`                                                      | the pool, serial program and host imports that the ownership gates and timing scripts share                                                                                                                     |
| `ownership-relational-probe.ts`, `ownership-stackidx-probe.ts`                                                                             | one serial run of a mutant read from stdin on the ground-truth inputs; the adversary kills it when it does not return                                                                                           |
| `ownership-ground-worker.ts`                                                                                                               | runs a record in 8 pages and in 12 pages with the extra pages poisoned; a different trap or byte means the module reads the memory size                                                                         |
| `router-ablation.ts`                                                                                                                       | five-mode router study on the development or final drivers: `run` times each arm in a fresh process per round, `certify` records the route decisions, `summary` gives geomeans and the slowest tenth            |
| `elastic-governor.ts`                                                                                                                      | fault-budget governor for one paged request, replayed on census traces with an injectable clock; a research instrument until the G-E2 gate passes                                                               |
| `elastic-model.ts`                                                                                                                         | trace-driven cost model of the managed fixture; the costs are parameters, not measurements                                                                                                                      |
| `gap-model.ts`                                                                                                                             | loads the B1, B2 and C prediction files against pinned SHA-256 hashes and reports the meter margin of each route to the 203 MiB kill line                                                                       |
| `elastic-controls.mjs`                                                                                                                     | checks `touched-raw.json` against `predictions.json` and the capacity-local rows, then writes `summary.json`                                                                                                    |
| `elastic-analyze.mjs`, `elastic-verify-backing.mjs`                                                                                        | asserts the capacity-local records against their backing rows; checks each backing file against its recorded size and per-page digests                                                                          |
| `elastic-managed-analyze.ts`, `elastic-latency-split.mjs`                                                                                  | asserts the managed envelope record (exact, 192 MiB, 15,360 faults, 960 handoffs); splits the `/run` and `/ready` requests of a tail file into per-call terms                                                   |
| `elastic-limits-summary.ts`, `elastic-limits-promote.ts`                                                                                   | turns the platform ladder and spill raw files into `summary.json`; promotes a live run into results with ordinal module ids and no resource ids                                                                 |
| `elastic-translate.ts`, `elastic-translate-host.ts`, `elastic-walk.ts`                                                                     | the Binaryen pass that routes each load and store through a page table, with exempt, hoist, census, elision, cache and pinned-range modes; its host half with the typed traps; the expression walker it uses    |
| `elastic-elide.ts`                                                                                                                         | static check elision: groups the accesses off one pointer expression and reports which checks a group can share                                                                                                 |
| `elastic-pager.ts`, `elastic-pager-glue.ts`                                                                                                | a frames pool with a CLOCK hand and a store under a translated module, the host accessor that makes the emscripten heap views read through its page table, and the glue patch that installs it                  |
| `translation-span.ts`, `translation-tax-summary.ts`                                                                                        | page span of the hot set and region split; `summary.json` of the tax study with paired tau per arm, class shares and the G-tau block (the optimizing tier is exploratory)                                       |
| `translation-tau2-summary.ts`, `translation-duration-summary.ts`                                                                           | tau per route with a median interval for the quiet-rig sweep (a gate claim needs ten quiet pairs per route); tau against request duration, one row per workload and render rung                                 |
| `export.ts`, `evidence.ts`                                                                                                                 | copy a run into `results/` with summaries and a manifest; verify every manifest and the historical index                                                                                                        |
| `environment.ts`, `backing.ts`, `corpus-worker.ts`, `crossover-worker.ts`, `grain-worker.ts`, `plot.py`                                    | the environment record every harness writes; the backing ablation; worker entries of the harnesses above; standalone figures from frozen summaries                                                              |

```sh
node scripts/research/export.ts results/topic/study run.jsonl:raw.jsonl
node scripts/research/evidence.ts --summaries
```

The study README must exist before `export.ts` writes the manifest. Timing studies need a quiet
host: record the load average in the data and discard a run that overlapped other work.

## C21 bulk harness

`c21-kernels.ts` builds one bulk driver per entry of its `specs` list (38 entries). A
driver runs `n` independent records through the unmodified entry point of one corpus kernel.
`c21-bench.ts` runs the automatic, forced, explicit and explicit-1 arms against the native serial
run and asserts equal output in every run. `c21-worker.ts` is the worker entry for the explicit
arms, `c21-common.ts` holds the shared record and memory helpers, and `cases/c21/` holds the C
driver sources (`bulk.c`, `support-bulk.c`). `c21-routes.ts` prints the stack and iteration routes
of built modules, and `c21-summary.mjs` pairs the timed rows of each arm against the native run.

Eight drivers cover six more projects (brotli, wyhash, BLAKE2, QOA, yyjson, md4c). Their cases sit
in `bulkCases` of `corpus-manifest.json`, not in `cases`, because `corpus.ts` builds every entry of
`cases` through `cases/kernel.c`. These projects need libc declarations and helpers that
`cases/c21/include/` and `cases/c21/support-libc.c` supply for them only. The bulk build fetches a
project archive on first use. `c21-verify.ts` runs each of the eight serially twice and compares
the output with Node's BLAKE2b, Node's Brotli decoder, a JSON parse, a wyhash port, a round trip
and known Markdown output:

```sh
node scripts/research/c21-verify.ts blake2b wyhash brotli-compress brotli-decompress
```

The drivers compile from the corpus sources. Run the corpus build first:

```sh
node scripts/research/corpus.ts build build/research/corpus/build.jsonl
```

The build reads `build/research/corpus/` and downloads an archive only when it is missing. Every
archive is checked against its pinned SHA-256. Clang comes from `LLVM` when set, otherwise from
Homebrew's LLVM on macOS, otherwise from `PATH`. Drivers are built with `node_modules/.bin` removed
from `PATH`, as `fixtures.ts` does.

| variable                  | effect                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `C21_OUT`                 | module directory, relative to the repo root (default `build/research/c21`)          |
| `C21_N`                   | records per run (default from the driver's spec)                                    |
| `C21_ARMS`                | comma list of arms to run, for example `automatic,explicit`                         |
| `C21_READWIN=1`           | iteration read windows on (default off)                                             |
| `C21_GATE=0`              | keep read windows armed whatever the counted batch says (default: the gate decides) |
| `C21_WARM=1`              | also write the warm-up rounds as samples, with a negative `round`                   |
| `C21_LOGCEILING`          | iteration log ceiling, in entries                                                   |
| `C21_FORCE_REFUSED=1`     | run the forced arm in timed mode even when the automatic route refuses              |
| `FOLIO_RESEARCH_REVISION` | revision label in the environment record (falls back to `git rev-parse HEAD`)       |

```sh
node scripts/research/c21-kernels.ts                    # every driver
node scripts/research/c21-kernels.ts sha256 miniz-crc32 # named drivers
mkdir -p build/research/c21-runs
node scripts/research/c21-bench.ts counters miniz-crc32 build/research/c21-runs/counters-miniz-crc32.jsonl 2 8
node scripts/research/c21-bench.ts timed miniz-crc32 build/research/c21-runs/timed-miniz-crc32-1.jsonl 5 8
node scripts/research/c21-summary.mjs build/research/c21-runs/timed-*-1.jsonl
```

Each bench command takes `ID OUTPUT.jsonl [ROUNDS] [WIDTH]`. The output file must not exist, and its
directory must. Counters mode runs two rounds of the automatic and forced arms. Timed mode runs two
warmups and then `ROUNDS` measured rounds of each arm.

On the Linux rig, `c21-rig.sh` runs the full sequence under the timing lock `/tmp/folio-timing.lock`,
pinned to CPUs 4 to 11 with `nice -n 19` and `taskset`:

```sh
FOLIO_RIG_NODE=/path/to/node FOLIO_RESEARCH_REVISION=rig-label \
  bash scripts/research/c21-rig.sh 3 5 build/research/c21-runs/rig
```

`FOLIO_WIDTH` sets the worker count (default 8). The script writes the module hashes, the counters
and timed JSONL files, `summary.json` and `summary.txt` under the output directory, and `finished`
when it completes.

A timed run puts every arm in one process, in the order `automatic`, `forced`, `explicit`,
`explicit-1`, and V8 shares the optimized code of a module between the pools that load the same
bytes. An arm that runs second can therefore start warm, so a comparison between arms in that
output depends on the order. `C21_ARMS` sets the order as well as the subset. `c21-arms.sh` runs
each arm of each driver in its own process, with the same pinning and lock, and
`c21-arms-table.mjs` prints the median speedup over sessions and the number of sessions above 1.0:

```sh
FOLIO_RIG_NODE=/path/to/node FOLIO_RESEARCH_REVISION=rig-label \
  bash scripts/research/c21-arms.sh 3 5 build/research/c21-runs/arms
```

`C21_OVERWRITE=1` makes the worker pass the ranges `writeRecords` sets to `restore()`, so the reset skips them. `C21_ARMS=inplace` runs the in-place arm: one shared memory holds the records and each worker runs a slice of the bulk entry on the unmodified module with its own stack (`c21-inplace-worker.ts`), for specs without a config block and with at most the stack pointer global. `copy-bandwidth.mjs` measures how fast 1, 2, 4 and 8 threads copy a shared buffer into a wasm memory.

`C21_SHARED=1` makes the explicit arm encode each task into a `SharedArrayBuffer` and submit it with
`{ share: true }`, so the pool posts the bytes without copying them. `c21-shared.sh` runs the
explicit arm for five programs at n of 64, 512 and 4096 as copy, shared, skip and in-place variants, one fresh process per
cell under the same lock and pinning. `C21_PROGRAMS`, `C21_SIZES` and `C21_VARIANTS` narrow the
matrix, and `c21-shared-table.mjs` prints the median speedup per variant with the range over
sessions:

```sh
FOLIO_RIG_NODE=/path/to/node FOLIO_RESEARCH_REVISION=rig-label \
  bash scripts/research/c21-shared.sh 3 5 build/research/c21-runs/shared
```

`affine-rig.sh` runs the affine, state-in-memory, sweep and shared-input timings in sequence on the
rig. The rig has no `wasm-ld`, so build the modules on another machine, copy `build/research/` over
with the sources and pass the Node binary:

```sh
FOLIO_RIG_NODE=/path/to/node FOLIO_RESEARCH_REVISION=rig-label \
  bash scripts/research/affine-rig.sh build/research/affine-runs/rig
```

## Probes

The probes are the instruments behind the figures in `TECHNICAL_REPORT.md`. They stay out of the
Bun lane because they measure Node's `worker_threads`, shared backing stores and thread affinity,
which Bun does not implement the same way. Moving a file does not change what it measures;
rewriting it might, so change one only with a paired run against the old version.

| file                       | measures                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sharing-probe.mjs`        | backing-store identity, aliasing, atomics, RSS controls, growth, creator exit                                                                                                                                               |
| `cpu-probe.ts`             | tiny, stream and compute kernels at 1, 2 and 4 workers                                                                                                                                                                      |
| `large-probe.ts`           | the 256 MiB combined capacity and CPU proof                                                                                                                                                                                 |
| `scaling-probe.ts`         | the 207-sample 1/2/4/8 worker sweep with profiling                                                                                                                                                                          |
| `control-probe.mjs`        | the generalized C entry, untouched against 1/2/4/8 workers                                                                                                                                                                  |
| `control-affinity.mjs`     | the same entry with pinned and unpinned workers                                                                                                                                                                             |
| `integration-probe.ts`     | real tinyimg and machine core artifacts against native instances                                                                                                                                                            |
| `artifact-coverage.ts`     | per-export inspect coverage and real Linux process-memory differential calls                                                                                                                                                |
| `php-preparation.ts`       | shipping PHP original/emitted function counts and generated helper census                                                                                                                                                   |
| `php-render.ts`            | shipping PHP boot and uncached Drupal render, native against prepared Folio                                                                                                                                                 |
| `pages-probe.ts`           | actual native Wasm over bounded page leases against a complete native oracle                                                                                                                                                |
| `consumer.ts`              | any Wasm consumer, native against 1/2/4/8 workers, whole memory compared                                                                                                                                                    |
| `php-workloads.ts`         | ten PHP userland workloads on the shipping artifact, native against Folio                                                                                                                                                   |
| `php-render-pairs.ts`      | the uncached Drupal render in alternating native and Folio processes                                                                                                                                                        |
| `purity-census.ts`         | why each function of a module is not a worker region, by first blocking rule                                                                                                                                                |
| `admission-calibration.ts` | synthetic regions that fit the admission cost model: instruction speed, region overhead, tracked access cost                                                                                                                |
| `admission-sites.ts`       | every region candidate of each consumer with its estimate, verdict and the default threshold                                                                                                                                |
| `old-build.ts`             | unpacks the archived pre-admission `src/` so a harness can run it beside the current build                                                                                                                                  |
| `php-contexts.ts`          | N private PHP instances in N worker threads: values, in-thread timestamps and thread CPU per run                                                                                                                            |
| `php-concurrent.ts`        | independent PHP requests at 1/2/4/8 widths in four arms, plus per-context memory                                                                                                                                            |
| `drupal-breakdown.ts`      | the uncached Drupal render split into SQL, ROM inflate, lazy compile and PHP execution                                                                                                                                      |
| `php-intra.ts`             | one request submitting independent jobs to private PHP contexts (explicit task API), against plain PHP                                                                                                                      |
| `indirect-sites.ts`        | counts the targets of every `call_indirect` in the PHP artifact while it renders                                                                                                                                            |
| `php-snapshot.ts`          | clones a PHP context by copying its Wasm memory and times the copy                                                                                                                                                          |
| `worksp.ts`                | counts or traces one PHP request (count or trace mode) and writes its work-span ladder                                                                                                                                      |
| `worksp-instrument.ts`     | rewrites the PHP module with counters, load and store hooks, and allocator, output and `execute_ex` extents                                                                                                                 |
| `worksp-recorder.ts`       | turns dispatch events and accesses into userland-call segments with merged intervals                                                                                                                                        |
| `worksp-hooks.ts`          | the hook imports a worker binds to an instrumented module, and the record it returns                                                                                                                                        |
| `worksp-refcount.ts`       | the counter experiment that checks refcount tags (0 verified sites)                                                                                                                                                         |
| `php-regen.ts`             | regeneration of a Drupal page set by 1 to 16 private contexts pulling from one queue, against serial                                                                                                                        |
| `php-blocks.ts`            | warm Drupal render with N placed blocks: variant and response marks, isolated block builds, write tables                                                                                                                    |
| `site-concurrency.ts`      | one workerd process against several for a real Drupal payload: forced full renders, throughput, footprint                                                                                                                   |
| `boot-image.ts`            | captures a booted context's memory, bakes it with `src/bake.ts`, renders from it, times delivery; `FOLIO_BOOTIMAGE_ROOT`, `FOLIO_PIN_SOURCE` and the two `FOLIO_PIN_*_SHA256` digests keep a second interpreter build apart |
| `bake-secrets.ts`          | what a baked image holds: leak scans, replay with the rekey step, RNG state, host-call census of a replay, heap sweep for secret-shaped strings                                                                             |
| `product-bake.ts`          | reads a Durable Object host's heap snapshot from its SQLite file, bakes it, writes the host source that uses it                                                                                                             |
| `page-drop.ts`             | labels each page of a baked image by dlmalloc chunk, drops free-chunk pages, searches the pages a render does not read                                                                                                      |
| `bake-rekey.ts`            | the PHP that gives a replayed Drupal heap its site's salt, key and random seed                                                                                                                                              |
| `php-sql-census.ts`        | statement log of node, user, term, render and cron units: tables touched, pair conflicts, SQL share of wall                                                                                                                 |
| `tasks-runtime.ts`         | the task pool's behavior checks under the runtime that runs the script (Node or Bun)                                                                                                                                        |
| `workerd-concurrency.ts`   | CPU-bound requests at 1 to 16 concurrent against one workerd process and against four                                                                                                                                       |
| `worksp-validate.ts`       | differential validation of private sites: serial digest against the explicit task API on private contexts                                                                                                                   |

`php-preparation.ts` and `php-render.ts` need a checkout of the Drupal-on-Wasm consumer with its dependencies and
a restored interpreter. `FOLIO_CONSUMER` names it, and `FOLIO_HOST_MODULES` names a JSON file that maps the
roles the probes import (`fs`, `mask`, `worker-shim`, `codec`, `site-store`) to paths under the checkout.
`php-render.ts` bundles the consumer's TypeScript with esbuild first, because Node does
not strip types under `node_modules`, then runs `native` or `folio` mode.

## Consumers

`consumer.ts CONSUMER.ts OUTPUT.jsonl [PAIRS] [WORKERS] [CASES]` loads the default export of a file in
`consumers/`: `name`, `bytes`, an optional `imports()` that returns fresh imports (and the memory
when the module imports one), and `cases`. A case's `prepare(api)` runs untimed on the raw exports
and returns the calls to time; `finish(api)` undoes its allocations; `batch` sends the calls through
one `runAll`. Each round runs every arm once in a rotating order. The digest of the whole memory
and the returns must agree across arms within a round, or the run throws. `paired.ts SET FILE`
summarizes the rows into `FILE.summary.json`: paired speedup, CPU ratio, workers and regions
dispatched, replays and fallbacks.

`FOLIO_OLD_BUILD=1` makes `consumer.ts`, `php-workloads.ts` and `php-render-pairs.ts` add old-build
arms (`old-N`) to every round, using `old-build.ts` and a separate prepared PHP plan. The archive
lives in `results/execution/admission/`, so no git history is needed to rerun the comparison.
`consumers/small-trips.ts` runs a compute loop whose bound is a parameter, at a count below the
admission threshold and at one just above it, to show what the per-call check does.

`admission-calibration.ts OUT.jsonl [PAIRS]` times compute-only and streaming regions of known size
with every region admitted, and `bun scripts/analyze/admission.ts SET` fits the constants that
`src/extract.ts` uses: native nanoseconds per estimated unit, the serial cost of one region at two
and eight workers, and the cost of one tracked memory access, with the break-even region size
for two and eight workers. `admission-sites.ts OUT.jsonl CONSUMER.ts...` lists where each consumer's
spans and pure functions fall against the threshold.

`purity-census.ts` reads a module with Binaryen and gives each defined function the first rule that
keeps it out of a worker region (a global access, `call_indirect`, an import call, an impure
callee). It also counts how many functions would be pure if the stack pointer global were allowed.
`scripts/analyze/profile.ts` attributes a V8 CPU profile to exported wasm functions and, given the
census, to those rules.

The PHP probes need `FOLIO_CONSUMER`, as above. `php-workloads.ts OUTPUT.jsonl [PAIRS] [WORKERS]
[PLAN] [NAMES]` runs the workloads inside one process with one PHP instance per arm.
`php-render-pairs.ts OUTPUT.jsonl [PAIRS] [WORKERS]` starts one process per sample, and its CPU
column is the process CPU between the two Drupal stages.

`php-contexts.ts` bundles `php-context-worker.ts` and `php-context-drupal.ts` with esbuild and the
consumer's TypeScript (the bundle can be built on one machine and shipped alone with
`FOLIO_WORKER_BUNDLE`). The compiled Wasm module is the only object shared between threads. A
Drupal context gets its own in-memory SQLite database loaded from the read-only seed files, its own
lazy ROM mount in its own Emscripten filesystem, and its own PHP heap. The bundle swaps the
consumer's `fflate` import in `lazy-fs.ts` for `timed-fflate.ts`, which times ROM inflation without
editing the consumer. `openContexts({ count, kind, mode })` takes `kind` `plain` or `drupal` and
`mode` `native` (the original module) or `folio` (`Folio.open` with a plan). `run`, `runAll` and
`render` return `startMs`, `endMs` (epoch milliseconds, comparable across threads), `cpuMs`
(`process.threadCpuUsage`), the output digest and, for Drupal, SQL and inflate time. `overlapMs`
gives the time two or more runs were active together.

`php-concurrent.ts cpu|drupal OUT.jsonl [PAIRS] [WIDTHS]` and `php-concurrent.ts memory OUT.jsonl
cpu|drupal native|folio COUNT` take `FOLIO_CONSUMER`, `FOLIO_WORKER_BUNDLE`, `FOLIO_PLAN` and
`FOLIO_MACHINE`. `drupal-breakdown.ts OUT.jsonl [PROCESSES] [INSTANCES]` opens the instances of one
process one after another, so instance 0 pays lazy Wasm compilation and later ones reuse the compiled
code. `scripts/analyze/concurrent.ts` and `breakdown.ts` summarize the rows.

`php-tasks.ts` and `php-task-bridge.ts` are the explicit task API, which is not automatic extraction.
The transport is `TaskPool` and `serveTasks` from `src/tasks.ts`; these files add the PHP side. The owner
context (index 0) reaches two host functions through `vrzno_env`, `cfwTaskSubmit` and
`cfwTaskJoin`; the PHP shim in `prelude` wraps them as `task_submit($fn, $args)` and `task_join($id)`.
Arguments and results travel as `base64(serialize(...))`, the owner blocks in `Atomics.wait` while it
joins, and each server context runs one named function at a time. `php-intra.ts OUT.jsonl [PAIRS]
[WIDTHS] [WORKLOADS]` alternates a `plain` arm (direct calls), an `api-inline` arm (the API in one
context) and `api-W` arms, and records task intervals, thread CPU, copy sizes and wait time.
`indirect-sites.ts OUT.jsonl [RENDERS]` and `php-snapshot.ts OUT.jsonl [SAMPLES]` take the same
environment variables. `scripts/analyze/intra.ts` summarizes all three.

`worksp.ts OUT.jsonl count|trace INPUTS [REPEATS] [RC_SITES.json]` takes inputs from `drupal-render`,
`hash-chains`, `dependent-chain`, `serialize-json`, `twig-render` and `calls`; trace mode needs a heap
of several GB (`FOLIO_WORKSP_HEAP_MB`) and about 150 s for the Drupal render. `scripts/analyze/worksp.ts`
holds the ladder, the task rung and the summary. `shared-var` is a fifth input whose calls share a global.
`FOLIO_WORKSP_FINE` (`all` or a label list) makes those invocations opcode-grained, `FOLIO_WORKSP_PRIV`
is a JSON object of input name to task rungs (`labels`, `all` or `auto`), and `FOLIO_WORKSP_EXPOSURE=0`
and `FOLIO_WORKSP_DEADSTACK=0` switch a recorder rule off for a comparison. `worksp-validate.ts OUT.jsonl
[SAMPLES]` runs the differential validation of the private sites.

## Rig

`scripts/rig/php-intra.sh SET` runs the explicit API and snapshot probes (`FOLIO_STEPS` picks
the steps). `scripts/rig/php-concurrent.sh SET` and `drupal-breakdown.sh SET` run the PHP probes above from a staged
directory (`FOLIO_STAGE`: the consumer subset, the worker bundle and the admit plan), under the same
lock, `nice 19` and a CPU mask (`FOLIO_RIG_MASK`, default `2-11`).

`scripts/rig/run.sh KIND [LABEL]` runs one probe on the Ryzen rig under `nice 19` and a fixed CPU
mask, holds the timing lock and writes `results/exit-code`. `KIND` is `sharing`, `cpu`, `large`,
`all`, `scaling`, `control` or `affinity`. `FOLIO_RIG_NODE` and `FOLIO_RIG_SWEEP` override the Node
binary and the sweep helper.

## Rules

- A script that writes an artifact takes its target as an argument or writes under `build/` or a
  named `results/` set.
- Never run a measurement on a machine with other work queued; the rig takes a lock for that.
- Keep raw samples. A summary is regenerated from them and never edited by hand.
