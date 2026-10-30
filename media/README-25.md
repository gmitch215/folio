# LZ4 Consumer

Question: does the iteration route speed up a second outside program with a loop over several inputs, and
what happens to a loop it cannot win?

The program is the C implementation of LZ4 (`lz4/lz4`, commit `ebb370ca83af`, archive SHA256 `eb1a93e9...ffa9`,
BSD-2-Clause), `lib/lz4.c` built freestanding to wasm32 and unmodified. `scripts/research/cases/lz4-compress-all.c`
adds one entry, `compress_all(table, n, out, capacity)`, which calls `LZ4_compress_default` for each of `n` inputs
into its own slot of `capacity` bytes, stores each size after the slots and returns the total compressed
size. It carries no hint. `scripts/research/lz4-build.ts` checks the archive digest and writes the modules
below. This record does not interpret the licence file of the project.

Inputs are seeded pseudo-text with a compression ratio of 2.03 to 2.06, generated in the bench. Every sample
asserts that the output equals the serial run, and the bench decodes the serial output with an independent
block decoder and checks every input round-trips.

## Modules

| File | What it is |
| --- | --- |
| `lz4-compress-all.wasm` | the entry as specified: the slot size is a run-time argument and the loop returns a running total |
| `lz4-compress-slots-{64k,256k,4m}.wasm` | the same loop with a compile-time slot size (`compress_slots(table, n, out)`), no total, one 4-byte size per loop step ("packed" below) |
| `lz4-compress-padded-{64k,256k,4m}.wasm` | as `slots`, with each size in its own 32-byte granule ("padded" below) |

A slot is `LZ4_compressBound` of the input rounded up to 4 KiB: 69,632, 266,240 and 4,214,784 bytes for 64 KiB,
256 KiB and 4 MiB inputs.

## What the route does with it

`prepare(bytes).iterationRoute` on `lz4-compress-all.wasm` is not eligible. The loop is a countdown loop with
a constant-stride table pointer and a run-time-stride output pointer, which the route accepts, and it also
writes `total`, a local that the code after the loop reads. The route refuses an accumulator it cannot
reproduce, so `Folio.run` runs the entry serially. A shared host memory passed to this module gives
`LinkError` at `Folio.open`, because the module declares an unshared memory; the `default` arm passes an
unshared memory and runs serially with `reason: unsupported-module`.

The `slots` and `padded` modules are eligible. Their deepest stack use is 16,416 bytes (the 16 KiB
`LZ4_stream_t`), inside the 32 KiB slot of an iteration.

## Method

Ryzen 9 9900X, Node 26.10.0, cores 4 to 11, `nice -n 19`, `powersave` governor, 3 sessions of 9 rounds after
2 warmups, width 8, one pool alive at a time, each arm paired with a native serial run in the same round.
Arms: `default` (unshared host memory, serial by design, so about 1.00x is pair noise) and `automatic`
(`Folio.open(bytes, { memory, workers: 8 })` with a shared host memory, then `run`). Wall time includes
placing the inputs. Workloads: `large` is 32 inputs of 4 MiB, `small` is 128 inputs of 256 KiB and `tiny` is
512 inputs of 64 KiB (padded module only).

## Results

Paired median speedup of the `automatic` arm over the serial run, with the range over rounds, three sessions.

| Workload | Module | Session 1 | Session 2 | Session 3 | Outcome of the route |
| --- | --- | --- | --- | --- | --- |
| 32 x 4 MiB | packed | 0.99x (0.99 to 1.00) | 0.99x (0.97 to 1.00) | 0.99x (0.99 to 1.00) | `log-exhausted` after a few iterations |
| 32 x 4 MiB | padded | 0.99x (0.98 to 1.00) | 0.99x (0.99 to 1.00) | 0.99x (0.98 to 1.00) | `log-exhausted` |
| 128 x 256 KiB | packed | 0.97x (0.95 to 0.99) | 0.97x (0.95 to 0.98) | 0.96x (0.93 to 0.98) | `log-exhausted` |
| 128 x 256 KiB | padded | 0.97x (0.96 to 0.98) | 0.97x (0.96 to 0.98) | 0.96x (0.93 to 0.98) | `log-exhausted` |
| 512 x 64 KiB | padded | 0.87x (0.86 to 0.94) | 0.86x (0.86 to 0.92) | 0.87x (0.85 to 0.92) | `no-admission` after one batch |
| 128 x 256 KiB | spec shape | serial | serial | serial | `unsupported-module`, no route |

The speedup is 1.00x or below in every cell, and there is no cell where the route helps LZ4.

- **The undo log is the limit.** An iteration that writes more than 2,048 granules (64 KiB) of tracked bytes
  exhausts its log. At 4 MiB and 256 KiB the compressed output alone is about 2 MiB and 128 KiB, so the
  first iterations exhaust the log, the batch rolls back, and the loop runs serially with
  `reason: 'log-exhausted'`. When an iteration fails, the workers start no further iteration of its batch, so
  the lost work is the iterations already running: 5 to 8 of the 32 of a batch. The cost is 1% to 4% of the
  serial wall. `Folio.open` has no option for a larger log and no default changed.
- **The packed size table also conflicts.** Eight 4-byte sizes share one 32-byte write granule, which the
  validator reports as write-after-write. It never decides the result here, because the log is exhausted
  first, and the padded module shows the same speedups.
- **At 64 KiB inputs the iterations fit the log and still lose.** The route runs one batch of 32
  iterations, finds its wall 2.1 to 3.9 times the serial time of those iterations (iteration 0 takes about
  0.11 ms) and ends dispatch, which costs 13% of the serial wall (0.87x). The cost of tracked execution and validation of about 1,500 granules per iteration was not
  separated from dispatch.
- **Equality.** Output equals the serial run in every sample, and every input round-trips.

Limits: one library, one machine, three module families, inputs of a fixed ratio. There is no `explicit` arm
for LZ4. Whether a larger undo log would make 256 KiB and 4 MiB inputs profitable was not tested, because the
log capacity is not reachable through `Folio.open`. The 64 KiB workload was added to see the route run
without a stop for the log.

## Reproduction

```sh
node scripts/research/lz4-build.ts
node scripts/research/lz4-bench.ts out.jsonl 9 32 4 slots
node scripts/research/analyze.ts out.jsonl summary.json
```

`scripts/research/lz4.sh SESSIONS ROUNDS [OUTPUT_DIRECTORY]` runs the six cells for each session under the timing
lock with `nice -n 19` and cores 4 to 11. The build downloads the pinned archive and refuses a digest that
differs.

## Artifacts

- `rig-{packed,padded}-{large,small}-N.jsonl`, `rig-padded-tiny-N.jsonl` and `rig-spec-shape-small-N.jsonl` (N
  from 1 to 3): raw records, with `*.summary.json` paired summaries from `analyze.ts`. `packed` is the
  `slots` module, `spec-shape` is `lz4-compress-all.wasm`.
- `lz4-compress-*.wasm`: the modules the sessions ran.
- `rig-before.log`: memory, load and governor at the start.
- `source.tar.gz`: `src/`, `scripts/research/` and `package.json` as run.
- `manifest.json`: byte lengths and SHA256 digests.
