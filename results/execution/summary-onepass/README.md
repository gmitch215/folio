# One-Pass Summary

Question: when the end state of a loop over a byte stream is a linear function of its start state, can workers summarize slices of the shared input in one pass and reach the serial result at a CPU cost near the serial run?

The kernel is a bitwise CRC-32C (`scripts/research/cases/affine/stream.c`): `update(state, ptr, length)` calls `transition(state, byte)` once per byte. The [stream checker](../../../scripts/research/stream-check.ts) reads the compiled module, accepts the loop skeleton, evaluates `transition` symbolically over GF(2) and returns a model with an operator matrix. With that model the end state of a slice run from state 0 gives the end state from any start state, `predictEnd(model, start, length, offset)`, so slices can run in parallel and the host composes them in order. `certificate.json` records the check: 84 checked expressions, 112 of 112 split-and-unsplit comparisons equal to the serial state, and five mutated modules refused (finalization call, hidden global, extra store, nonlinear step, an active data segment).

## Arms

Four arms run in each round, with the order alternated between rounds:

- `serial`: one call of `update` over the whole input in the main thread.
- `one-shared`: one task per worker over its slice, each worker reading the shared input memory in place. Each task starts from state 0 and the host composes the end states.
- `one-copy`: the same, but each task receives a copy of its slice, which the worker copies into private memory before the call.
- `two-shared`: the two-pass exact fold (`foldExact`). Pass 1 runs every slice but the last from state 0 and the model turns the offsets into predicted start states. Pass 2 runs every slice but the first from its predicted start, and the host compares each real end state with the next predicted start. The arm is absent at one worker.

Every sample compares the final state of its arm with the serial state, and all 450 samples match.

## Results

Speedup over the serial run of the same round, then CPU time over the serial CPU time in parentheses. Median over 3 sessions of the per-session median over 5 rounds, 64 MiB input:

| Workers | One-pass shared | One-pass copied | Two-pass shared |
| ---: | --- | --- | --- |
| 2 | 1.98x (1.01) | 1.50x (1.28) | 0.99x (1.01) |
| 4 | 3.91x (1.01) | 3.00x (1.23) | 1.97x (1.52) |
| 8 | 6.41x (1.03) | 4.22x (1.18) | 3.41x (1.79) |

At 8 MiB and 8 workers the one-pass shared arm reaches 3.95x (CPU 1.08), one-pass copied 3.47x and two-pass 2.49x. Fixed costs bound the smaller input. At one worker the shared arm runs at 1.00x and the copied arm at 0.84x to 0.87x.

The eight-worker result at 64 MiB varies across sessions: one-pass shared 5.14x to 7.68x, one-pass copied 4.15x to 4.59x, two-pass 3.20x to 3.80x. The one-pass shared arm varies by 0.15x or less across sessions in every other cell. The copied arm at 8 MiB and 8 workers ranges from 3.02x to 5.18x.

The serial kernel runs at 297 to 305 MB/s (27.5 to 28.2 ms for 8 MiB, 220.9 to 222.7 ms for 64 MiB). The kernel is one bitwise CRC-32C on one machine. Each byte costs about 3.3 ns of serial work, so this is a best case for scaling. No memory-bound kernel was run in this study.

`summary.json` is the output of `summary-onepass-table.mjs` over `cells/`: serial median wall time, speedup, CPU ratio, session count and the speedup range over sessions for each cell. Every cell and arm in it has an exact final state, checked inside each round.

## Setup

The 24 cells are fresh processes, one per session, input size and worker count (3 sessions, sizes 8 and 64 MiB, widths 1, 2, 4 and 8). Each cell runs 2 warmup rounds and 5 measured rounds. They ran on the Ryzen rig (Ryzen 9 9900X, cores 4 to 11) with Node 26.10.0, under the timing lock, `nice -n 19` and `taskset -c 4-11`. The cell files record the Node version and not the hardware; the `.before.log` and `.after.log` files beside each cell record the time, the load average and the exit status. The one-minute load average before a cell was 0.02 to 1.20.

All 24 cells started within 3 minutes (the first logs read 20:09:22Z and the last 20:11:58Z), so the three sessions are back-to-back repeats and not samples from separate days. `progress.log` shows that the first pass exited with status 1 on all six width-1 cells; those six cells were rerun after the other 18 and exited with status 0. The cause of the first failure was not recorded. The width-1 cells are the ones in `cells/` that carry the later timestamps.

## Limits

- One kernel, one machine, one input pattern, three sessions.
- The checker accepts one compiled loop skeleton with a pure step. It does not prove the module free of other behavior, and exclusive, immutable input is a declaration the caller makes. The certificate states that it needs independent review and is not a proof-assistant or SMT certificate.
- Each process runs all four arms in sequence, so V8 may start a later arm with warm code. The arm order alternates to spread that, and it is not independent arm processes.
- Speedups are ratios inside each round against the serial arm of that round.

## Reproduction

On a machine with clang and `wasm-ld`, build and certify the module, which writes `stream.wasm` and `certificate.json`:

```sh
node scripts/research/summary-certify.ts build/research/summary-onepass-cert
```

On the Linux rig, run the cells under the timing lock (`FOLIO_RIG_NODE` names the Node binary):

```sh
FOLIO_RIG_NODE=/path/to/node bash scripts/research/summary-onepass.sh \
  build/research/summary-onepass-cert/stream.wasm build/research/summary-onepass-rig
```

Table and summary from the recorded cells:

```sh
node scripts/research/summary-onepass-table.mjs results/execution/summary-onepass/cells build/research/summary.json
```

The table output is byte for byte equal to `summary.json`. `summary-certify.ts` rebuilt `stream.wasm` and `certificate.json` byte for byte on the M2 Pro with Node 26.8.2 and Homebrew LLVM; other compiler versions can produce a different module, and the certificate names the digest of the one used here. All scripts refuse to overwrite an existing file.

## Artifacts

- `cells/`: 24 cell files named `s<session>-m<MiB>-w<workers>.json`, with `.before.log` and `.after.log` records for each.
- `progress.log`: the exit status of each cell in run order.
- `summary.json`: per-cell medians and ranges.
- `certificate.json`: the checker's evidence for `stream.wasm`.
- `stream.wasm`: the compiled kernel (532 bytes).
- `manifest.json`: byte lengths and SHA256 digests.
