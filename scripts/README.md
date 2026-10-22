# `scripts/`

The folder decides the runtime.

| where              | what                                                           | runtime                   |
| ------------------ | -------------------------------------------------------------- | ------------------------- |
| `scripts/build/`   | C fixture compilation and prepared-plan generation             | Bun, also runs under Node |
| `scripts/analyze/` | deterministic summaries of the raw samples in `results/`       | Bun, also runs under Node |
| `scripts/probe/`   | measurement instruments that need real `worker_threads` and V8 | Node 26                   |
| `scripts/rig/`     | the timing rig on Paisley Park (`taskset`, `nice`, a lock)     | Bash                      |

Everything outside `probe/` and `rig/` is TypeScript and uses `import.meta.main`, so
`bun scripts/build/fixtures.ts` and `node scripts/build/fixtures.ts` both work.

## Build

`fixtures.ts` compiles `tests/c/*.c` to `build/*.wasm` with the freestanding LLVM flags the
measurements used. `LLVM` points at a toolchain directory, and Homebrew's LLVM is the default on
macOS. The compiler runs with `node_modules/.bin` removed from `PATH`: binaryen installs a
`wasm-opt` there, clang runs it after linking when it finds one, and `bun run` adds that directory
to `PATH`. With it, `generalized.wasm` is 458 bytes. Without it, the 511-byte artifact the
evidence names.

`prepare.ts` runs the compiler over `fixture.wasm` and `generalized.wasm` and writes
`build/probe.json` and `build/control-prepared.json`, which the probes read.

## Analyze

`bun scripts/analyze/run.ts` regenerates every `results/*/summary.json` from its raw `.jsonl`.
Each analyzer also takes a set name: `bun scripts/analyze/control.ts 20261020-control-b`. The
outputs match the summaries recorded on Paisley Park byte for byte, with one exception:
`results/20261019/summary.json` lists its input files in sorted order now, because directory
listing order differed between the two machines.

## Probes

The probes are the instruments behind the figures in `TECHNICAL_REPORT.md`. They stay out of the
Bun lane because they measure Node's `worker_threads`, shared backing stores and thread affinity,
which Bun does not implement the same way. Moving a file does not change what it measures;
rewriting it might, so change one only with a paired run against the old version.

| file                       | measures                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sharing-probe.mjs`        | backing-store identity, aliasing, atomics, RSS controls, growth, creator exit                                |
| `cpu-probe.ts`             | tiny, stream and compute kernels at 1, 2 and 4 workers                                                       |
| `large-probe.ts`           | the 256 MiB combined capacity and CPU proof                                                                  |
| `scaling-probe.ts`         | the 207-sample 1/2/4/8 worker sweep with profiling                                                           |
| `control-probe.mjs`        | the generalized C entry, untouched against 1/2/4/8 workers                                                   |
| `control-affinity.mjs`     | the same entry with pinned and unpinned workers                                                              |
| `integration-probe.ts`     | real tinyimg and machine core artifacts against native instances                                             |
| `artifact-coverage.ts`     | per-export inspect coverage and real Linux process-memory differential calls                                 |
| `php-preparation.ts`       | shipping PHP original/emitted function counts and generated helper census                                    |
| `php-render.ts`            | shipping PHP boot and uncached Drupal render, native against prepared Folio                                  |
| `pages-probe.ts`           | actual native Wasm over bounded page leases against a complete native oracle                                 |
| `consumer.ts`              | any Wasm consumer, native against 1/2/4/8 workers, whole memory compared                                     |
| `php-workloads.ts`         | ten PHP userland workloads on the shipping artifact, native against Folio                                    |
| `php-render-pairs.ts`      | the uncached Drupal render in alternating native and Folio processes                                         |
| `purity-census.ts`         | why each function of a module is not a worker region, by first blocking rule                                 |
| `admission-calibration.ts` | synthetic regions that fit the admission cost model: instruction speed, region overhead, tracked access cost |
| `admission-sites.ts`       | every region candidate of each consumer with its estimate, verdict and the default threshold                 |
| `old-build.ts`             | unpacks the archived pre-admission `src/` so a harness can run it beside the current build                   |
| `php-contexts.ts`          | N private PHP instances in N worker threads: values, in-thread timestamps and thread CPU per run             |
| `php-concurrent.ts`        | independent PHP requests at 1/2/4/8 widths in four arms, plus per-context memory                             |
| `drupal-breakdown.ts`      | the uncached Drupal render split into SQL, ROM inflate, lazy compile and PHP execution                       |
| `php-compile.ts`           | the Zend compile share of the Drupal render under the shipped opcache arms, plus a timer per include         |
| `php-intra.ts`             | one request submitting independent jobs to private PHP contexts (explicit task API), against plain PHP       |
| `indirect-sites.ts`        | counts the targets of every `call_indirect` in the PHP artifact while it renders                             |
| `php-snapshot.ts`          | clones a PHP context by copying its Wasm memory and times the copy                                           |
| `worksp.ts`                | counts or traces one PHP request (count or trace mode) and writes its work-span ladder                       |
| `worksp-instrument.ts`     | rewrites the PHP module with counters, load and store hooks, and allocator, output and `execute_ex` extents  |
| `worksp-recorder.ts`       | turns dispatch events and accesses into userland-call segments with merged intervals                         |
| `worksp-hooks.ts`          | the hook imports a worker binds to an instrumented module, and the record it returns                         |
| `worksp-refcount.ts`       | the counter experiment that checks refcount tags (0 verified sites)                                          |
| `php-regen.ts`             | regeneration of a Drupal page set by 1 to 16 private contexts pulling from one queue, against serial         |
| `php-blocks.ts`            | warm Drupal render with N placed blocks: variant and response marks, isolated block builds, write tables     |
| `site-concurrency.ts`      | one workerd process against several for a real Drupal payload: forced full renders, throughput, footprint    |
| `boot-image.ts`            | captures a booted context's memory, bakes it into the module with binaryen, renders from it, times delivery  |
| `php-sql-census.ts`        | statement log of node, user, term, render and cron units: tables touched, pair conflicts, SQL share of wall  |
| `tasks-runtime.ts`         | the task pool's behavior checks under the runtime that runs the script (Node or Bun)                         |
| `workerd-concurrency.ts`   | CPU-bound requests at 1 to 16 concurrent against one workerd process and against four                        |
| `worksp-validate.ts`       | differential validation of private sites: serial digest against the explicit task API on private contexts    |

`php-preparation.ts` and `php-render.ts` need a checkout of the Drupal-on-Wasm consumer with its dependencies and
a restored interpreter. `FOLIO_CONSUMER` names it. `php-render.ts` bundles the consumer's TypeScript with esbuild first, because Node does
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
lives in `results/20261020-regress/`, so no git history is needed to rerun the comparison.
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
`php-compile.ts OUT.jsonl [ROUNDS] [INCLUDE_ROUNDS]`, `indirect-sites.ts OUT.jsonl [RENDERS]` and
`php-snapshot.ts OUT.jsonl [SAMPLES]` take the same environment variables. `scripts/analyze/intra.ts`
summarizes all four.

`worksp.ts OUT.jsonl count|trace INPUTS [REPEATS] [RC_SITES.json]` takes inputs from `drupal-render`,
`hash-chains`, `dependent-chain`, `serialize-json`, `twig-render` and `calls`; trace mode needs a heap
of several GB (`FOLIO_WORKSP_HEAP_MB`) and about 150 s for the Drupal render. `scripts/analyze/worksp.ts`
holds the ladder, the task rung and the summary. `shared-var` is a fifth input whose calls share a global.
`FOLIO_WORKSP_FINE` (`all` or a label list) makes those invocations opcode-grained, `FOLIO_WORKSP_PRIV`
is a JSON object of input name to task rungs (`labels`, `all` or `auto`), and `FOLIO_WORKSP_EXPOSURE=0`
and `FOLIO_WORKSP_DEADSTACK=0` switch a recorder rule off for a comparison. `worksp-validate.ts OUT.jsonl
[SAMPLES]` runs the differential validation of the private sites.

## Rig

`scripts/rig/php-intra.sh SET` runs the compile, explicit API and snapshot probes (`FOLIO_STEPS` picks
the steps). `scripts/rig/php-concurrent.sh SET` and `drupal-breakdown.sh SET` run the PHP probes above from a staged
directory (`FOLIO_STAGE`: the consumer subset, the worker bundle and the admit plan), under the same
lock, `nice 19` and a CPU mask (`FOLIO_RIG_MASK`, default `2-11`).

`scripts/rig/run.sh KIND [LABEL]` runs one probe on Paisley Park under `nice 19` and a fixed CPU
mask, holds the timing lock and writes `results/exit-code`. `KIND` is `sharing`, `cpu`, `large`,
`all`, `scaling`, `control` or `affinity`. `FOLIO_RIG_NODE` and `FOLIO_RIG_SWEEP` override the Node
binary and the sweep helper.

## Rules

- A script that writes an artifact takes its target as an argument or writes under `build/` or a
  named `results/` set.
- Never run a measurement on a machine with other work queued; the rig takes a lock for that.
- Keep raw samples. A summary is regenerated from them and never edited by hand.
