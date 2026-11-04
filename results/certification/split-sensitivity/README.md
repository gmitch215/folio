# Split Sensitivity

Question: when a function composes only for some ways of cutting its input, do the sampling probe,
exact mode and the spike stream checker notice?

A byte-stream function composes when two calls over the two halves of a range, with the state carried
across, return what one call over the whole range returns. Parallel folding assumes this for every cut.
The study builds 21 small modules around a bitwise CRC-32C step and tests that assumption directly
against what each instrument accepts.

## Inputs

The 21 modules come from WAT text in `scripts/research/split-sensitivity.ts`. Each has 32 pages of
memory, growable to 512, and an `update(state, pointer, length)` export. The groups are:

- A control, an index-counted loop that computes the same function, and a final xor on every call.
- Length hazards: a bit flipped when the call length equals K (`n == K`) or reaches K (`n >= K`) for K
  of 1,000, 4,096, 65,537, 100,000 and 262,144, a separate `length-trigger` module that flips one bit at
  exactly 262,144 bytes (the same bytes as `length-eq-262144`), and the length mixed into the result.
- A position hazard: the byte xor the index parity.
- A rare-state step that flips one bit when the register reaches a value that the reference input
  produces after 100,000 bytes.
- A nonlinear step (state times byte), `h * 31 + byte` over Z/2^32, a table-driven CRC-32 with a 256-entry
  data segment, and Adler-32.

## Instruments

Ground truth runs a chain of two calls and a single call over the whole range for lengths 0, 1, 7, 64,
1,000, 4,096, 65,537, 100,000 and 262,144, start states 0, 1, 0x80000000 and 0xffffffff, and cuts at
one third, one half and the last byte. A module whose chain differs anywhere is a hazard. The record
keeps the first failing case.

The sampling probe is `probeAffine` from `src/affine.ts`. Exact mode is `foldAffine` over the 262,144-byte
reference input with four workers, compared with the unsplit call. The spike stream checker is
`checkStream` in `scripts/research/stream-check.ts`.

## Results

Counts from the 21 rows of `raw.json`:

| Measure | Count |
| --- | ---: |
| Modules where the chain differs from the unsplit call (hazards) | 14 of 21 |
| Hazards the probe refuses | 4 of 14 |
| Hazards the probe accepts as a model | 10 of 14 |
| Hazards where exact mode returns a wrong state at 262,144 bytes | 6 of 14 |
| Hazards the spike checker accepts | 0 of 14 |
| Compositional modules the spike checker accepts | 1 of 7 |

The probe refuses the final xor, the length mixed into the result, the position parity and
`n >= 1000`. It accepts every `n == K` module and every other `n >= K` module.

Exact mode is wrong at 262,144 bytes for six hazards: the `n == 262144` flip (the same module bytes as
the first length trigger), `n >= 4096`, `n >= 65537`, `n >= 100000` and `n >= 262144`. Four
more hazards return the right state at that length and are wrong at a shorter one:

| Module | Exact mode at 262,144 bytes | First split failure |
| --- | --- | --- |
| `length-eq-1000` | correct | length 1,000, cut 333 |
| `length-eq-4096` | correct | length 4,096, cut 1,365 |
| `length-eq-65537` | correct | length 65,537, cut 21,845 |
| `length-eq-100000` | correct | length 100,000, cut 33,333 |

The unsplit call at 262,144 bytes never meets `n == K` for these four, and exact mode's state equals it.
For K = 262,144 the unsplit call meets the trigger and exact mode's state differs.

The seven compositional modules are the control, the index-counted wrapper, the rare-state step, the
nonlinear step, `h * 31 + byte`, the table CRC and Adler-32. The spike checker accepts only the control.
It refuses the other six: the rare-state step and the nonlinear step are not affine, so those refusals are
correct. The wrapper, `h * 31 + byte` (affine over Z/2^32), the table CRC (data segment) and Adler-32 (affine
over Z/65521) compute valid streaming functions outside the checker's class. The recorded reason for
each is in `raw.json`.

The rare-state module composes, and exact mode returns the correct state by fallback (`mismatchAt` 1 with
131,072 fallback bytes in the record).

The probe took 0.3 to 213.3 ms per module in this record and the checker 0.71 to 11.4 ms. Each is one
sample per module on one machine, so read them as orders of magnitude.

## Reproduction

```sh
node scripts/research/split-sensitivity.ts build/research/split-sensitivity.json
```

Needs Node 26. The script refuses to overwrite an existing file. Every column except `probeMs` and
`checkerMs` is deterministic. A rerun matched `raw.json` on all 21 rows for the module digests, ground
truth, probe, exact mode and checker columns.

## Artifacts

- `raw.json`: the recorded output of the script, one row per module.
- `manifest.json`: byte lengths and SHA256 digests.

## Scope and Limits

The modules are constructed hazards, not code found in the wild. The record comes from one machine and
names only the Node version (v26.8.2). The ground truth samples nine lengths, four
start states and three cuts, so it can miss a hazard outside those lengths; a flip at a length it does not
test would count as compositional. Exact mode was run only at 262,144 bytes with four workers. The study
says nothing about the widened certifier, which the spike checkers are the baseline for.
