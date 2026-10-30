# SHA-256 Consumer

Question: does the iteration route speed up a second outside program that hashes several inputs, and does
the way the loop is written change the answer?

The program is the SHA-256 of `B-Con/crypto-algorithms` (commit `cfbde48414ba`, archive SHA256
`525d7b38...f477`, public domain), `sha256.c` built freestanding to wasm32 and unmodified.
`scripts/research/cases/sha256-hash-all.c` adds one entry, `sha256_all(table, n, out)`, which hashes each of `n`
inputs (a table of offset and length pairs) into 32 bytes of `out`, and returns `n`. It carries no hint.
`scripts/research/sha256-build.ts` checks the archive digest and writes two modules:

| File | What it is |
| --- | --- |
| `sha256-hash-all.wasm` | the plain loop: the digest context is a local of `sha256_all`, so it lives in the owner frame |
| `sha256-hash-helper.wasm` | the same loop with the per-input work in a `noinline` helper, so the context lives in a callee frame |

Inputs are seeded pseudo-random bytes. Before sampling, the bench asserts that every serial digest equals the
digest that Node's `crypto` computes for that input, and every sample asserts that the digest table equals
the serial run.

## What the route does with it

Both modules are eligible: a countdown loop with a constant-stride table pointer and output pointer. The plain
loop was not eligible in an earlier build, because the compiler updates the table pointer in the middle of
the body and the route accepted only trailing updates; it now accepts an update anywhere at the top level.
Stack use is 368 bytes for either module, inside the 32 KiB slot.

## Method

Ryzen 9 9900X, Node 26.10.0, cores 4 to 11, `nice -n 19`, `powersave` governor, 3 sessions of 9 rounds after
2 warmups, width 8, one pool alive at a time, the serial run paired in each round. The `automatic` arm is
`Folio.open(bytes, { memory, workers: 8 })` with a shared host memory, then `run('sha256_all')`. Wall time
includes placing the inputs. Workloads: `large` is 32 inputs of 1 MiB and `small` is 128 inputs of 256 KiB, both
32 MiB, with a serial wall of about 105 ms. The `default` arm (unshared host memory, serial by design) sits
at 0.99x to 1.01x in every cell and is not tabulated.

## Results

Paired median speedup of the `automatic` arm over the serial run, with the range over rounds, three sessions.

| Workload | Module | Session 1 | Session 2 | Session 3 | Process CPU ratio |
| --- | --- | --- | --- | --- | --- |
| large | helper | 2.12x (1.74 to 2.16) | 1.79x (1.73 to 2.08) | 2.14x (1.76 to 2.18) | 3.24 to 3.29 |
| small | helper | 1.76x (1.63 to 1.95) | 1.83x (1.71 to 1.98) | 1.73x (1.59 to 2.03) | 3.42 to 3.47 |
| large | plain | 1.24x (1.00 to 1.26) | 1.18x (1.00 to 1.25) | 1.02x (1.00 to 1.26) | 5.78 to 5.85 |
| small | plain | 1.00x (0.93 to 1.02) | 0.96x (0.91 to 1.01) | 1.04x (0.99 to 1.25) | 3.56 to 3.66 |

- **The helper form gains 1.7x to 2.1x.** Every sample dispatched, replayed nothing and equals the serial
  digests. The speedup is below the width because the route pays for marks and validation, and the tracked
  work is about 3.3 times the CPU of the serial run.
- **The plain form dispatches and gains little.** On `large` the route dispatches one batch of 31 iterations
  and reaches 1.0x to 1.2x at 5.8 times the CPU. On `small` the batch rule ends dispatch after two batches
  in 24 of 27 samples (`no-admission`), and the cell is 0.96x to 1.04x. The plain loop keeps the digest
  context in the owner frame, and the route tracks that frame byte by byte; the helper keeps it in a callee
  frame, which it does not track. The CPU ratio of 5.8 against 3.3 is consistent with that cost, and the
  cost was not isolated.
- **Admission does not predict the plain result.** The pre-check passes (the remaining serial time is about
  100 ms), and on `large` the single batch is the last one, so nothing is left to stop. The loop finishes at
  about the serial wall and burns several times the CPU.
- **Equality.** Every digest equals the serial result and Node's, in every sample. The gate test runs eight
  inputs of 0 to 1,000 bytes (around the 56 and 64 byte padding edges) through both modules at widths 2 and 4
  against Node.

Limits: one library, one machine, equal-size inputs. The helper form needed a change to the program's shape to
dispatch well, so this is a result about one loop written two ways and not about SHA-256 in general. There is
no `explicit` arm.

## Reproduction

```sh
node scripts/research/sha256-build.ts
node scripts/research/sha256-bench.ts out.jsonl 9 32 1024 helper
node scripts/research/sha256-bench.ts out.jsonl 9 32 1024 all
node scripts/research/analyze.ts out.jsonl summary.json
```

`scripts/research/sha256.sh SESSIONS ROUNDS [OUTPUT_DIRECTORY]` runs the four cells for each session under the
timing lock with `nice -n 19` and cores 4 to 11. The build downloads the pinned archive and refuses a digest
that differs.

## Artifacts

- `rig-{helper,plain}-{large,small}-N.jsonl` (N from 1 to 3): raw records, with `*.summary.json` paired
  summaries from `analyze.ts`.
- `sha256-hash-all.wasm`, `sha256-hash-helper.wasm`: the modules the sessions ran.
- `rig-before.log`: memory, load and governor at the start.
- `source.tar.gz`: `src/`, `scripts/research/` and `package.json` as run.
- `manifest.json`: byte lengths and SHA256 digests.
