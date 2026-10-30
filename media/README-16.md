# BLAKE3 Consumer

Question: on a program that Folio did not shape and the corpus does not contain, what do default
admission, forced admission and the explicit task route do?

The program is the C implementation of BLAKE3 1.8.7 (tag commit `f3149ec5bb54`, archive SHA256
`c6782a28...6a3c`), built freestanding to wasm32 on its portable path with the SIMD paths disabled, and
unmodified. `scripts/research/cases/blake3-hash-all.c` adds one entry in the shape of a `b3sum` run over
several files: `hash_all(table, n, out)` calls `blake3_hasher_init`, `blake3_hasher_update` and
`blake3_hasher_finalize` for each of `n` inputs placed in memory by the host. It carries no grain and no
hint. The upstream licence files are `LICENSE_CC0`, `LICENSE_A2` and `LICENSE_A2LLVM`; this record does not
interpret them.

Chunks are 1,024 bytes and a hash is a binary tree of chunks, so the work inside one input and across
inputs is independent. Inputs here are pseudo-random buffers held by the host, as if read from files.

## Method

Equality. `scripts/research/blake3-build.ts` verifies the archive digest and the commit recorded in its
header, builds, and checks the module against the 35 official test vectors (input byte `i` is `i % 251`).
Every timed sample also asserts that every digest equals the serial result.

Timing. Three independent sessions on the Ryzen machine (Node 26.10.0, cores 4 to 11, `nice -n 19`,
`powersave` governor), one pool alive at a time, the serial run paired in each round and alternating
which goes first, 9 rounds after 2 warmups, width 8. Arms:

- `default`: `Folio.open` and `run('hash_all')` under default admission.
- `explicit`: one task per input on `TaskPool` workers, each with a private context sized to one input
  and an `InstanceCheckpoint` restore before every task. The input crosses to the worker by copy and is
  written into the worker's memory inside the timing. The serial arm also places its inputs inside the
  timing.
- `forced`: `minimumRegionWork` 0, a smaller workload (8 inputs of 1 MiB, 3 rounds), as a diagnostic.

Workloads: `large` is 32 inputs of 4 MiB (128 MiB), and `small` is 128 inputs of 256 KiB (32 MiB).

## Results

Paired median speedup over the serial run, with the range over rounds.

| Workload | Arm | Session 1 | Session 2 | Session 3 | Process CPU ratio |
| --- | --- | --- | --- | --- | --- |
| large | default | 1.00x | 1.00x | 1.00x | 1.00 |
| large | explicit | 2.97x (2.53 to 3.28) | 3.12x (2.62 to 3.40) | 2.80x (2.43 to 3.89) | 1.8 to 2.0 |
| small | default | 0.97x | 0.98x | 0.98x | 1.01 to 1.02 |
| small | explicit | 2.79x (2.26 to 3.57) | 2.79x (2.08 to 3.69) | 2.54x (2.30 to 3.09) | 1.8 to 2.0 |
| forced | forced | 0.40x | 0.47x | 0.51x | 2.1 to 2.7 |

- **Default admission finds no plan.** `Folio.run` runs the original module serially with no worker
  (mode `serial`, reason `unsupported-module`). The blockers are module-wide: a start function or a
  required shared memory, data segments that need initialization isolation, global state (the stack
  pointer) and a recursive call graph (`blake3_compress_subtree_wide`), and no region reaches the
  200,000-unit floor.
- **The explicit route clears 2x on both workloads,** 2.5x to 3.1x at eight workers. The serial
  calling thread posts 128 MiB of input by copy before the workers can hash, which limits the
  speedup below the width.
- **Forced admission loses.** It forms regions, runs speculatively on three workers with 48 replays
  in each session, and is 0.40x to 0.51x of the serial run on the small diagnostic workload.
- This is an explicit result: the caller names one task per input. It is not an automatic speedup.
  The [iteration route](../iteration-route/README.md) later made the `default` arm dispatch this loop;
  this study keeps the earlier record.

Limits: one program, one machine, 3 sessions of 9 rounds, and a pool that holds each worker's inputs by
copy. The `forced` cell has 3 rounds and a workload one eighth the size of `large`.

## Reproduction

```sh
node scripts/research/blake3-build.ts
node scripts/research/blake3-bench.ts out.jsonl 9 32 4 run
node scripts/research/blake3-bench.ts forced.jsonl 3 8 1 forced
node scripts/research/analyze.ts out.jsonl summary.json
```

`scripts/research/blake3.sh SESSIONS ROUNDS [OUTPUT_DIRECTORY]` runs the three cells for each session
under the timing lock with `nice -n 19` and cores 4 to 11. The build downloads the pinned archive from
the upstream repository and refuses a digest or commit that differs.

## Artifacts

- `large-N.jsonl`, `small-N.jsonl`, `forced-N.jsonl` (N from 1 to 3): raw records.
- `*.summary.json`: paired summaries from `analyze.ts`.
- `blake3-hash-all.wasm`: the module the sessions ran.
- `before.log`: memory, load and governor at the start.
- `source.tar.gz`: `src/`, `scripts/research/` and `package.json` as run.
- `manifest.json`: byte lengths and SHA256 digests.
