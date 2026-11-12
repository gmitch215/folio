# External Applications

Question: does Folio's automatic route speed up three unchanged outside programs that were not written for it?

Programs: aobench (a ray tracer), 6pack with FastLZ (a file compressor) and llama2.c (a language-model inference loop), each built at `-O2` and run as one call of `main`. The pass line, fixed before any Folio run, was a median of at least 1.20 over serial Wasm with an interval above 1.0 on the rig.

Result: the pass line is not met. On all three programs the automatic route stayed serial (`unsupported-module`, 0 workers) and the paired speedup over serial Wasm reads 1.002 (0.999 to 1.007) for aobench, 1.002 (0.996 to 1.004) for 6pack and 1.001 (0.998 to 1.003) for llama2.c, all inside 0.996 to 1.007. The `shared` link variant reads 0.998 to 1.001. No wrong output in the timed rig samples.

The reasons come from `Folio.inspect('main')`. No region reaches the 200,000-unit admission threshold (26, 22 and 47 pure functions). The iteration route refuses all three: aobench nests its pixel and ray loops in one function, 6pack and llama2.c have their compress and matmul loops inlined into larger functions, and the trip counts of the generation loops cannot be computed before the loop starts. No loop calls into the worker set. `decide()` on `main` refuses because `main(argc, argv)` does not fit the ownership call convention, which says nothing about the programs. The five-mode ablation was not run.

A diagnostic with `minimumRegionWork: 0` on one Mac call took aobench to 16,840,903 regions and about 0.04x of serial. 6pack and llama2.c produced no row within the 600 s limit, and the cause was not diagnosed.

## Inputs

| Path | Contents |
| --- | --- |
| `raw/rig-20261111-071526-plain.jsonl`, `raw/rig-20261111-071526-shared.jsonl` | rig samples, one row per app, arm and round (`serial`, `folio`, `native`), with wall time, route, output digest and `passed` |
| `rig-plain.summary.txt`, `rig-shared.summary.txt` | per app and arm: median, speedup over serial, bootstrap interval, wrong outputs, routes |
| `rig-snapshot.txt`, `rig-20261111-071526.log` | the source-tree snapshot and the run log |
| `inspect/inspect-plain-*.json` | `Folio.inspect('main')` output per program |
| `raw/decide-plain.jsonl` | `decide()` refusals on `main` |
| `raw/mac-run1.jsonl`, `raw/mac-run2-plain.jsonl`, `raw/force-plain-mac.jsonl` | Mac runs under load, indicative only, and the forced-admission diagnostic |

## Instrument

`scripts/research/external-apps/` builds the programs with a freestanding libc layer written for the study and runs the paired rounds. Seven rounds per arm, a fresh process per arm and round, two untimed warm calls and one timed call of `main`. The rig is an x86_64 Ryzen 9 9900X in a container with ten CPUs. The pre-registration was written before any Folio run (SHA-256 `4ad6723769b47b6abaa27206aeb5458f1300dd4e58cebccace91056aa00b0f4b`).

## Limits

The libc layer is the study's own. `sscanf` was added to it after the first llama2.c comparison and before any Folio run. The `plain` link variant was added after the first run stayed serial, and both variants are reported. `src/` changed between the two Mac runs, and the rig used the later snapshot. Native is a child process timed around the spawn, so it is not the quantity the in-process arms measure, and aobench's native output differs from the Wasm output on the rig (glibc libm against musl). The Mac rows (1.016, 1.081 and 0.953 for the three programs) ran at a load average of 6 to 9, and the 6pack figure is load noise on a path that was serial in both arms. Whether a `-fno-inline` build of llama2.c would expose independent matmul rows was not tried.
