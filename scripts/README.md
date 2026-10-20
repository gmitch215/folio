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

| file                   | measures                                                                      |
| ---------------------- | ----------------------------------------------------------------------------- |
| `sharing-probe.mjs`    | backing-store identity, aliasing, atomics, RSS controls, growth, creator exit |
| `cpu-probe.ts`         | tiny, stream and compute kernels at 1, 2 and 4 workers                        |
| `large-probe.ts`       | the 256 MiB combined capacity and CPU proof                                   |
| `scaling-probe.ts`     | the 207-sample 1/2/4/8 worker sweep with profiling                            |
| `control-probe.mjs`    | the generalized C entry, untouched against 1/2/4/8 workers                    |
| `control-affinity.mjs` | the same entry with pinned and unpinned workers                               |
| `integration-probe.ts` | real tinyimg and gmux core artifacts against native instances                 |

## Rig

`scripts/rig/run.sh KIND [LABEL]` runs one probe on Paisley Park under `nice 19` and a fixed CPU
mask, holds the timing lock and writes `results/exit-code`. `KIND` is `sharing`, `cpu`, `large`,
`all`, `scaling`, `control` or `affinity`. `FOLIO_RIG_NODE` and `FOLIO_RIG_SWEEP` override the Node
binary and the sweep helper.

## Rules

- A script that writes an artifact takes its target as an argument or writes under `build/` or a
  named `results/` set.
- Never run a measurement on a machine with other work queued; the rig takes a lock for that.
- Keep raw samples. A summary is regenerated from them and never edited by hand.
