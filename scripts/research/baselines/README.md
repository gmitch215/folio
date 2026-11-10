# Baselines

Arms from other systems, run against the same drivers as Folio. Nothing here has run on the final corpus.

## Denominator rule

Every driver of the final corpus gets one row for every arm. An arm that cannot run a driver is reported as unsupported in the denominator, with a reason class, and is never dropped. A table that shows only the drivers an arm handled overstates it.

Reason classes used so far: `not-a-reduction`, `no-state-entry`, `allocator`, `shared-scratch`, `state-outside-class`, `end-to-end-mismatch`, `imports`, `side-effect`, `entry-failed`, `source-only-input` (the arm reads C or C++ and cannot take a Wasm module), `build` (the arm's tool did not build or did not run on the host tried).

## Arms

| Arm                              | Status                                                        | Where                                           |
| -------------------------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| Native parallel-for              | done                                                          | `results/corpus/native-baseline/`               |
| Morihata and Sato, reimplemented | built, development corpus only                                | `morihata.ts`                                   |
| Jiang, Chen and Agrawal artifact | builds with a workaround; source-only input                   | scratch only, GPL-3.0 source is not copied here |
| Perspective                      | `build`: profiling runtime crashes on the emulated host tried | scratch only                                    |

## Morihata and Sato

`morihata.ts` takes a Wasm entry with the shape `(state, pointer, length) -> state` and infers a linear polynomial over a semiring from sampled calls on one byte, as in section 3 of the paper. It tries six semirings: (+, x), (max, +), (max, min), (min, max), (or, and) and (and, or). The paper's seventh, (max, x), is not implemented.

Random testing on one byte is the paper's validation. The tool adds one check the paper does not have: the split fold must equal the serial result on a 16 KiB sample before the verdict is `supported`. Without it, a modulus larger than the sampled values passes the body test and gives a wrong state.

Not covered: XOR and modular state (the paper's prototype has no such semiring), more than one reduction variable, loop decomposition, nested loops, array index inference.

`morihata-drivers.ts OUTPUT.json` writes the per-driver table for the 38 development drivers and the hand kernels. The unit test is `tests/unit/baselines-morihata.test.ts`.
