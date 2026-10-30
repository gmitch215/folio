# Iteration Route

Question: can default admission speed up a program Folio did not shape, with no hint in the program, no
default lowered and no feature turned off?

The program is the BLAKE3 consumer of the [blake3-consumer](../blake3-consumer/README.md) study: the C
implementation of BLAKE3 1.8.7, unmodified, with a `hash_all(table, n, out)` entry that hashes `n` inputs
in a loop. In that study `Folio.run` found no plan and ran serially (1.00x). This study runs the same module
through the iteration route.

## What the route does

`Folio.open(bytes, { memory, workers })` followed by `run('hash_all')` finds the loop in `hash_all`: one
countdown loop whose body calls into a function set that may use one stack-pointer global and recursion,
with a frame in the owner's stack. The owner module is rewritten so the loop is one host call, and the host
runs it in four steps.

1. **Time the first iteration.** Iteration 0 runs on the owner as the serial program's own first iteration,
   and its time decides whether the rest is worth dispatching (see [iteration-admission](../iteration-admission/README.md)).
2. **Dispatch the rest on private stack slots.** Iterations 1 and up run on the workers in batches of up to 32,
   each on its own 32 KiB stack slot, with inline read marks (64-byte granules), write marks (32-byte granules)
   and a copy-on-first-write undo record.
3. **Validate in order.** The owner checks read-after-write, write-after-read and write-after-write between
   the iterations of a batch. It also checks the owner frame byte by byte: an iteration that reads a frame
   byte before writing it, where an earlier iteration of the batch wrote that byte, is a conflict.
4. **Roll back and replay.** The first iteration that fails, and every later one in its batch, is rolled back
   from the undo logs and replayed serially at the owner. The serial result is the output.

An exhausted undo log, a frame conflict, a batch that replays more than half of its iterations or a batch
that loses to the serial time ends dispatch, and the rest of the loop runs serially with the reason in
`iteration.stopped`.

The route needs a shared host `memory`. A host that hands in an unshared memory through `imports` gets
`mode: 'serial'` with `reason: 'no-arena'`, which is the `default` arm below.

## Method

Three independent sessions on the Ryzen machine (Node 26.10.0, cores 4 to 11, `nice -n 19`, `powersave`
governor, load 0.0 to 1.3), one pool alive at a time, the serial run paired in each round and alternating
which goes first, 9 rounds after 2 warmups, width 8. The pool is opened once per arm, so the rounds are
warm calls; first use is measured separately below. Every sample asserts that every digest equals the
serial result. Workloads: `large` is 32 inputs of 4 MiB (128 MiB) and `small` is 128 inputs of 256 KiB
(32 MiB). Arms:

- `default`: `Folio.open` with an unshared host memory passed through `imports`.
- `automatic`: `Folio.open(bytes, { memory, workers: 8 })` with a shared host memory, then `run('hash_all')`,
  under default admission.
- `explicit`: one task per input on `TaskPool`, as in the blake3-consumer study.

The same arms ran three sessions on an Apple M2 Pro (Node 26.8.2, on AC power with the desktop in use, load
average 4 to 5), which is a replication of direction only.

## Results

Paired median speedup over the serial run, with the range over rounds. The `automatic` arm reported
`extraction: 'iteration'`, no replay and no stop in every sample.

Ryzen 9 9900X:

| Workload | Arm | Session 1 | Session 2 | Session 3 | Process CPU ratio |
| --- | --- | --- | --- | --- | --- |
| large | default | 1.00x (0.99 to 1.01) | 1.00x (1.00 to 1.00) | 1.00x (1.00 to 1.00) | 1.00 |
| large | automatic | 3.13x (2.79 to 3.21) | 2.43x (2.13 to 2.62) | 2.47x (2.17 to 3.11) | 1.70 to 1.74 |
| large | explicit | 3.26x (2.89 to 3.93) | 3.17x (2.15 to 3.54) | 3.03x (2.86 to 3.54) | 1.68 to 1.71 |
| small | default | 0.98x (0.97 to 1.03) | 0.99x (0.97 to 1.00) | 0.97x (0.97 to 1.04) | 1.01 to 1.02 |
| small | automatic | 2.06x (1.85 to 2.36) | 1.98x (1.34 to 2.40) | 2.01x (1.96 to 2.26) | 2.12 to 2.24 |
| small | explicit | 3.06x (1.82 to 3.97) | 3.32x (2.45 to 4.06) | 3.17x (2.13 to 3.98) | 1.66 to 1.79 |

Apple M2 Pro:

| Workload | Arm | Session 1 | Session 2 | Session 3 | Process CPU ratio |
| --- | --- | --- | --- | --- | --- |
| large | default | 0.97x (0.75 to 1.56) | 1.01x (0.99 to 1.27) | 0.99x (0.98 to 1.14) | 0.99 to 1.01 |
| large | automatic | 3.23x (2.97 to 3.55) | 3.52x (3.09 to 5.00) | 3.53x (3.39 to 3.92) | 1.62 to 1.68 |
| large | explicit | 5.19x (2.03 to 6.31) | 4.89x (1.65 to 6.31) | 5.16x (3.37 to 6.41) | 1.29 to 1.33 |
| small | default | 1.00x (0.97 to 1.02) | 1.00x (0.98 to 1.01) | 0.99x (0.99 to 1.01) | 0.99 to 1.01 |
| small | automatic | 2.90x (2.51 to 2.97) | 2.87x (2.69 to 2.95) | 2.81x (2.73 to 3.05) | 1.92 to 1.95 |
| small | explicit | 4.17x (3.29 to 5.07) | 4.82x (4.16 to 5.58) | 4.94x (4.26 to 5.08) | 1.51 to 1.75 |

- **The automatic arm reaches 2x or more on both workloads on both machines.** On the Ryzen machine the three
  session medians are 2.43x to 3.13x on `large` and 1.98x to 2.06x on `small`, so `small` sits at the line
  rather than clear of it. The same call was 1.00x and 0.97x to 0.99x in the blake3-consumer study.
- **The explicit route is faster,** by 0.1x to 0.7x on `large` and 1.0x to 1.3x on `small` on the Ryzen
  machine. The iteration route pays for inline marks (about 1.4x on one thread), a frame shadow,
  per-batch validation and a time-and-decide step. It needs no task boundary in the program.
- **First use.** Three cold runs on the Ryzen machine (`first-use-N.json`, `scripts/research/iteration-diff.ts
  blake3 32 4194304 8`, 32 inputs of 4 MiB). `Folio.open` takes 100 to 104 ms, the first `run` 111 to 115 ms
  against a serial run of 146 to 147 ms (it starts eight workers and compiles the lowered module in each),
  and the second `run` 57 to 62 ms. Counting `Folio.open`, one cold call takes 215 ms against 146 ms serial,
  and two calls take 272 to 277 ms against 292 to 294 ms. The route pays for itself from the second call on a
  `Folio` that stays open. The warm medians above exclude pool start and `Folio.open`.
- **Equality.** The digest check in every sample is an output equivalence. It does not mean the linear
  memory is byte-identical to the serial run: a dispatched run leaves stack-slot residue in the stack zone
  `[0, 65536)` and in the arena that follows the program memory. In `first-use-N.json`, `memoryEqual` holds
  for the whole memory outside those two regions, which includes the table, the outputs and the inputs, and
  the owner frame after the loop equals the serial frame in the gate tests. The gate tests, a generated
  family of 1,600 programs at widths 2, 4 and 8 (disjoint, read-after-write, write-after-read,
  write-after-write, framed, frame-carried, trapping and mixed shapes) and the existing differential family
  equal the serial result, and `prepare()` output for the plans of the existing corpus and fixtures is
  byte-identical to the tree before the route.
- **What a dispatched call does.** On `large`, `regions` is 31 (iteration 0 ran serially) in one batch,
  and the cold run of `first-use-N.json` held 2,728 undo entries. On `small` the call dispatches 127
  iterations in four batches. `replayed` is 0 throughout.

## Limits

- **The route accepts one loop shape.** A function with one countdown loop whose iterations are calls into
  a function set that may use one stack-pointer global and recursion. Pointer and counter updates may sit at any
  top-level position of the loop body, with a constant step or a step held in a local that the loop does not
  write. A local that the code after the loop reads is accepted when its step is constant and refused when it
  is a run-time step or an accumulator.
- **What the frame check covers.** A read of an owner frame byte that an earlier iteration of the same batch
  wrote is caught, so a dependence through the frame that appears only on a later iteration is caught too.
  Excluded: a read of stack below the owner frame (callee frames), and an imported host function that touches
  memory, which the marks do not see.
- **Loops that write much per iteration stop.** The undo log holds 2,048 write granules (64 KiB) per
  iteration. An iteration that writes more exhausts it, the batch rolls back and the loop runs serially. The
  [LZ4 study](../lz4-consumer/README.md) is such a loop and measures 0.96x to 0.99x.
- **A frame-heavy iteration dispatches without a gain.** In the plain SHA-256 loop the digest context lives in
  the owner frame, every byte of it is tracked, and the route reaches 1.0x to 1.2x at 5.8 times the CPU
  (see the [SHA-256 study](../sha256-consumer/README.md)). Admission does not predict this.
- **Refusals with a named reason:** a module that executes `memory.size` or `memory.grow`, a defined (not
  imported) memory, an unshared host memory, a host memory that cannot grow by the arena, 64-bit memory, a
  trip count of 0 (2^32 iterations), and `workers: 1`.
- **The arena** adds about 0.19 times the memory plus 3.6 MiB (bitmaps cover the whole memory), placed after
  the program's memory.
- **Two programs gain.** BLAKE3 (on two machines) and the helper form of SHA-256 (on the Ryzen machine). Inputs are of equal
  size. The 100-input set with two 64 MiB inputs was not run on this route, and a first iteration that
  differs much from the rest can mislead admission.
- **Node only.** The managed Workers backend cannot run this route: it needs one shared allocation,
  `Atomics` and threads, and Workers have none of them across isolates.
- The warm medians exclude pool start. The 2x claim is for a long-lived `Folio` that runs the loop more
  than once.

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
- `rig-before.log`, `mac-before.log`, `mac-after.log`: load, memory and governor.
- `blake3-hash-all.wasm`: the module the sessions ran.
- `source.tar.gz`: `src/`, `scripts/research/` and `package.json` as run on the rig.
- `manifest.json`: byte lengths and SHA256 digests.
