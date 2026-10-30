# Iteration Route

Question: can default admission speed up a program Folio did not shape, with no hint in the program, no
default lowered and no feature turned off?

The program is the BLAKE3 consumer of the [blake3-consumer](../blake3-consumer/README.md) study: the C
implementation of BLAKE3 1.8.7, unmodified, with a `hash_all(table, n, out)` entry that hashes `n` inputs
in a loop. In that study `Folio.run` found no plan and ran serially (1.00x). This study runs the same module
through the iteration route.

## What the route does

`Folio.open(bytes, { memory, workers })` followed by `run('hash_all')` finds the loop in `hash_all` (a
countdown loop whose body calls into the worker-side function set, with a frame in the owner's stack). The
owner module is rewritten so the loop becomes one host call. The host runs iteration 0 once on the lowered
module to time it and to probe for a frame-carried dependence, decides from the measured time whether
dispatch beats the serial wall (see [iteration-admission](../iteration-admission/README.md)), then runs the
iterations on the workers, each on a private stack slot, with inline read and write marks and an undo
record. Validation is ordered over batches of up to 32 iterations and checks read-after-write,
write-after-read and write-after-write. The first iteration that fails, and every later one in its batch,
is rolled back and replayed serially. The serial result is the output.

The route needs a shared host `memory`. A host that hands in an unshared memory through `imports` gets
`mode: 'serial'` with `reason: 'no-arena'`, which is the `default` arm below.

## Method

Three independent sessions on the Ryzen machine (Node 26.10.0, cores 4 to 11, `nice -n 19`, `powersave`
governor, load 0.9 to 2.1), one pool alive at a time, the serial run paired in each round and alternating
which goes first, 9 rounds after 2 warmups, width 8. The pool is opened once per arm, so the rounds are
warm calls; first use is measured separately below. Every sample asserts that every digest equals the
serial result. Workloads: `large` is 32 inputs of 4 MiB (128 MiB) and `small` is 128 inputs of 256 KiB
(32 MiB). Arms:

- `default`: `Folio.open` with an unshared host memory passed through `imports`.
- `automatic`: `Folio.open(bytes, { memory, workers: 8 })` with a shared host memory, then `run('hash_all')`,
  under default admission.
- `explicit`: one task per input on `TaskPool`, as in the blake3-consumer study.

The same three arms ran three sessions on an Apple M2 Pro (Node 26.8.2, on AC power with the desktop in
use, load 4.1 to 5.5), which is a replication of direction only.

## Results

Paired median speedup over the serial run, with the range over rounds. The `automatic` arm reported
`extraction: 'iteration'`, 0 replays and a clear probe in every session.

Ryzen 9 9900X:

| Workload | Arm | Session 1 | Session 2 | Session 3 | Process CPU ratio |
| --- | --- | --- | --- | --- | --- |
| large | default | 1.00x | 0.98x | 1.00x | 1.00 to 1.02 |
| large | automatic | 2.73x (2.61 to 2.76) | 3.23x (3.02 to 3.26) | 2.72x (2.69 to 2.74) | 1.63 to 1.70 |
| large | explicit | 3.37x (3.07 to 3.77) | 3.26x (2.82 to 3.50) | 3.18x (2.75 to 3.63) | 1.68 to 1.73 |
| small | default | 0.97x | 0.99x | 0.98x | 1.01 to 1.05 |
| small | automatic | 2.37x (2.13 to 2.49) | 2.18x (1.93 to 2.51) | 2.23x (1.65 to 2.45) | 2.06 to 2.17 |
| small | explicit | 3.31x (2.38 to 3.65) | 3.40x (2.02 to 3.92) | 3.55x (2.46 to 4.04) | 1.66 to 1.73 |

Apple M2 Pro:

| Workload | Arm | Session 1 | Session 2 | Session 3 | Process CPU ratio |
| --- | --- | --- | --- | --- | --- |
| large | default | 0.99x | 1.00x | 0.98x | 1.00 to 1.02 |
| large | automatic | 3.30x (2.75 to 4.15) | 3.39x (2.92 to 3.75) | 3.27x (1.80 to 5.53) | 1.62 to 1.65 |
| large | explicit | 4.10x (1.98 to 6.33) | 4.70x (2.96 to 5.95) | 4.75x (3.50 to 6.19) | 1.42 to 1.51 |
| small | default | 1.00x | 0.99x | 0.99x | 1.00 to 1.01 |
| small | automatic | 2.90x (2.61 to 3.39) | 2.80x (2.68 to 2.88) | 3.06x (2.47 to 3.30) | 1.82 to 1.94 |
| small | explicit | 4.12x (3.46 to 5.22) | 3.44x (2.89 to 4.15) | 3.77x (1.37 to 5.08) | 1.75 to 1.79 |

- **The automatic arm clears 2x on both workloads on both machines.** On the Ryzen machine the median of
  the three sessions is 2.73x on `large` and 2.23x on `small`. The same call was 1.00x and 0.98x in the
  blake3-consumer study.
- **The explicit route is still faster on the Ryzen machine,** by 0.03x to 0.64x on `large` and 0.94x to 1.32x on
  `small`. The iteration route pays
  for inline marks (about 1.4x to 1.8x on one thread), a serial probe iteration and per-batch validation.
  It needs no task boundary in the program.
- **First use.** Three cold runs on the Ryzen machine (`first-use-N.json`, `scripts/research/iteration-diff.ts
  blake3 32 4194304 8`): `Folio.open` takes 99 to 101 ms, the first `run` 103 to 109 ms against a serial
  run of 142 to 143 ms (it starts eight workers and compiles the lowered module in each), and the second
  `run` 60 to 61 ms. The probe took 5.5 ms of that.
- **Equality.** Beyond the digest check in every sample, `memoryEqual` holds for the whole memory outside
  the stack zone `[0, 65536)` and the arena in `first-use-N.json`. The gate tests, a generated family of
  1,600 programs at widths 2, 4 and 8 (disjoint, read-after-write, write-after-read, write-after-write,
  framed, frame-carried, trapping and mixed shapes, 9,600 comparisons) and the existing differential family
  (identical counts to `HEAD`) all equal the serial result. `prepare()` output for 58 plans, 29 modules at
  default admission and at `minimumRegionWork` 0, is byte-identical to the tree before the route.

## Limits

- **The route accepts one shape.** A function with one countdown loop whose iterations are calls into a
  function set that may use one stack-pointer global and recursion. A loop-carried dependence through
  memory is caught by validation. A dependence through the owner frame is caught only by the probe on
  iteration 0, which flags a first iteration that reads frame bytes it did not write. A read that happens
  only on a later iteration is not caught, and no sound cheap check exists (a byte-granular first-access
  mark on every frame access would add a branch to each).
- **The probe also flags loop-invariant frame data** that the owner stored before the loop, and runs that
  loop serially with `reason: 'frame-carried dependence'`.
- **Refusals with a named reason:** a module that executes `memory.size` or `memory.grow`, a defined (not
  imported) memory, an unshared host memory, a host memory that cannot grow by the arena, 64-bit memory, a
  trip count of 0 (2^32 iterations), and `workers: 1`.
- **The arena** adds about 0.19 times the memory plus 3.6 MiB (bitmaps cover the whole memory), placed after
  the program's memory. The memory after a dispatched run holds stack-slot residue; the equality contract
  masks `[0, 65536)` and the arena.
- **One program, two machines.** Equal-size inputs. The 100-input set with two 64 MiB inputs was not run
  on this route. The decision follows iteration 0 only.
- **Node only.** The managed Workers backend cannot run this route: it needs one shared allocation,
  `Atomics` and threads, and Workers have none of them across isolates.
- The warm medians exclude pool start. The 2x claim is for a long-lived `Folio` that runs the loop more
  than once; one cold call is 1.4x on this workload.

## Reproduction

```sh
node scripts/research/blake3-build.ts
node scripts/research/blake3-bench.ts out.jsonl 9 32 4 run
node scripts/research/analyze.ts out.jsonl summary.json
node scripts/research/iteration-diff.ts blake3 32 4194304 8
node scripts/research/differential.ts iteration OUTPUT_DIRECTORY 200
```

## Artifacts

- `rig-large-N.jsonl`, `rig-small-N.jsonl`, `mac-large-N.jsonl`, `mac-small-N.jsonl` (N from 1 to 3): raw
  records, with `*.summary.json` paired summaries from `analyze.ts`.
- `first-use-N.json`: the cold runs of `iteration-diff.ts blake3`.
- `rig-before.log`, `rig-after.log`, `mac-before.log`, `mac-after.log`: load, memory and governor.
- `blake3-hash-all.wasm`: the module the sessions ran.
- `source.tar.gz`: `src/`, `scripts/research/` and `package.json` at export.
- `manifest.json`: byte lengths and SHA256 digests.
