# Dynamic Guard Count for Paged Memory Access in a PHP WebAssembly Build

This study counts memory accesses, residency checks and calls made by one PHP 8.5 WebAssembly
module while it renders two web pages. The counts give the dynamic ratio of checks and calls to
memory accesses, which a paged-memory translation would pay on top of each access.

## Instrument

`count-pass.mjs` rewrites a WebAssembly module with binaryen. It adds three exported mutable i64
globals, `q_access`, `q_check` and `q_call`, and wraps each of these in a block that increments
the matching counter:

- Every `i32.load` and `i32.store`, and every `memory.copy` and `memory.fill`, increments
  `q_access`.
- A load or store through a base local counts one check the first time it runs after that local
  was last set. A `local.set` or `local.tee` of the base clears the flag. A load through any other
  pointer expression counts one check.
- Every `call` and `call_indirect` increments `q_call`.

A base is a `local.get`, or a `local.get` plus a constant. Flags are added as new i32 locals per
function, so they start at zero on every call.

`count-pass.test.mjs` runs the pass on a small module with a loop. The loop re-sets its base
locals on every iteration, and the test expects one check per iteration for each re-set base.

`bench-count.diff` is the only change to the rig harness. It lets the harness load a module from
an environment variable, and it reads the counters before and after each render.

## Modules

| Module | Size (bytes) | SHA-256 |
| --- | ---: | --- |
| Shipping native module | 14,011,467 | `3fb160241bdc702ab6b9d1b8a1a9e0acceae30e0e0ce5f4456f90214192b80ce` |
| Instrumented module | 47,495,637 | `98c1073e28cbd59a9248dd3879555d71a39f471f30ac017ca39b84c7ad07e4bc` |
| Harness with counter readout | 913,660 | `4f342d0c3fec121b02c88b9adeda66f5fff137435c5dc28e103ff8f261e0f4ec` |

The instrumented module keeps the 103 imports of the shipping module. Its feature set is the
set the shipping module validates with: MVP, sign extension, saturating float to int, multivalue,
bulk memory, bulk memory operations and mutable globals.

## Routes

Each route is one render in a fresh process, run under Node 26 and V8 14.6. The reported counts
are the difference between the counter values before and after the render call.

- `front`: the front page of the default site profile. The first render after boot is reported
  as `request`. Two warm renders in the same process are reported as `request2` and `request3`.
- `admin`: the content administration page of a second site profile, reached after a login.
  Only the render is counted.

The flush route is not measured. Its harness path does not call the render function that
carries the counters.

## Counts

Each row is one render. `q` is `(checks + calls) / accesses`. Two counted runs were made for
each route, and the table gives both.

| Route | Render | Run | Accesses | Checks | Calls | q | Checks / access | Calls / access |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| admin | request | 1 | 4,404,477,769 | 1,273,034,314 | 84,735,206 | 0.3083 | 0.2890 | 0.0192 |
| admin | request | 2 | 4,404,634,455 | 1,273,135,000 | 84,735,240 | 0.3083 | 0.2890 | 0.0192 |
| front | request | 1 | 1,907,973,973 | 587,832,697 | 35,754,530 | 0.3268 | 0.3081 | 0.0187 |
| front | request | 2 | 1,907,982,783 | 587,834,152 | 35,754,513 | 0.3268 | 0.3081 | 0.0187 |
| front | request2 | 1 | 117,009,980 | 30,893,017 | 2,333,781 | 0.2840 | 0.2640 | 0.0199 |
| front | request2 | 2 | 117,011,452 | 30,895,044 | 2,333,820 | 0.2840 | 0.2640 | 0.0199 |
| front | request3 | 1 | 110,657,199 | 29,524,149 | 2,233,212 | 0.2870 | 0.2668 | 0.0202 |
| front | request3 | 2 | 110,643,728 | 29,515,310 | 2,233,106 | 0.2869 | 0.2668 | 0.0202 |

The static count over the shipping module gives `(bases + calls) / accesses` of 0.3280. It counts
1,243,219 accesses, 312,673 distinct bases per function and 95,100 calls in functions that contain
an access. The static count does not weight sites by how often they run.

Every counted render produced the same normalized response hash as the plain render of the same
route. The plain renders are `075d2ff46df9d9e99b38c8ce6f9c6327ae6ee1935ee07472e561456666a8b80c`
for admin and `607acccc80413af3de38246caa3e77fb4fbac37359652c7254dd615cf75ad08d` for front.

Counts are not bit-identical between runs. Across the two runs the access count differs by up to
0.004 percent, and the checks and calls differ by similar small amounts. The ratio q agrees to
four decimal places.

## Limits

- The counts describe one module and two routes. Each route is one process, and boot work is
  not counted.
- The counters record site-level counts at run time. They do not measure cost, cache behaviour
  or the time a translation would take.
- Accesses are counted at the instruction level. A translation may treat a bulk operation or a
  group of nearby accesses differently.
- The pointer rule matches the static count. A base is a `local.get`, or a `local.get` plus any
  constant with any binary operator. An `and` with a constant would therefore count as a base.
- Run-to-run variation comes from the module and the harness. The source of the variation was
  not isolated.

## Files

- `count-pass.mjs`: the instrumentation pass and its command-line entry point.
- `count-pass.test.mjs`: fixture test for the pass.
- `bench-count.diff`: the harness change.
- `run-route.sh`: the runner for one render. Its paths are placeholders.
- `analyze-q.mjs`: computes the table from the run files and writes `summary.json`.
- `access-bases-tuned.txt`: the static count output for the shipping module.
- `raw-rows.json`: one row per counted or plain render, with counts, hashes and timing.
- `summary.json`: the table and the hash check.
