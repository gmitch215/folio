# Checker Red Team

Question: can a module that does not compose, or whose recorded model is wrong, get past the spike
stream checker or the spike loop checker, and how many valid modules do they refuse?

The spike checkers are `scripts/research/stream-check.ts` and `scripts/research/loop-check.ts`. The
stream checker accepts a `transition` step with the template wrapper loop. The loop checker accepts
one inline loop with a conditioning pair. A checker accepts when it proves the entry is a GF(2) affine
byte-stream function and returns its model. This study feeds both a corpus built to break them.

## Inputs

804 modules, each fed to both checkers. 349 are in the stream form (a step function and a wrapper)
and 455 in the loop form (one inline loop). A checker is only meant for its own form, so the counts
below tally each checker on its own form and report the other form separately.

| Generator | Group | Modules | What it holds |
| --- | --- | ---: | --- |
| `gen-ops.ts` | operators | 212 | 106 operator cases in both forms: shift counts, the negate idiom, `and` and `xor` shapes, tee and local order, unsupported operations |
| `gen-ops.ts` | fuzz | 140 | 70 random expression trees in both forms, seed `0x5eed1234` |
| `gen-wrapper.ts` | wrapper, state, conditioning, length | 119 | wrapper variants, state outside the loop, conditioning pairs, length and position dependence |
| `gen-loopstate.ts` | loopstate | 22 | state outside the loop and entry-shape variants of the loop form |
| `gen-raw.ts` | raw | 21 | hand-assembled binaries with pending operands under void statements and multi-value blocks |
| `gen-c.ts` | compiled | 290 | 58 C sources in `scripts/research/cases/redteam/` at -O0, -O1, -O2, -O3 and -Os |

`modules.json` has one row per module: id, group, note, source text (WAT, C or opcode bytes), the
SHA256 of the module, both verdicts with their reasons, the ground truth, the validity label and the
classification.

## Instruments

Ground truth runs a chain of two calls against one call at lengths 0, 1, 7, 64, 1,000, 4,096, 65,537,
100,000 and 262,144, states 0, 1, 0x80000000 and 0xffffffff, cuts at one third, one half and the last
byte, on a fresh instance per comparison. The model check folds zero-start chunk runs through
`predictEnd` for widths 1, 2, 4 and 8 at lengths 0, 1, 2, 31, 257, 65,537 and 262,144.

Every accepted module also gets a relocation check (the same bytes at four other addresses), the
recheck in `recheck.json` and the 1 MiB check in `big.json`. The validity label for refused modules
samples an operator from one-byte calls and confirms it on the model grid, so it can only err toward
"not valid".

## Results

Counts by checker on its own form, recounted from `modules.json`:

| | Stream checker | Loop checker |
| --- | ---: | ---: |
| Modules tried | 349 | 455 |
| Accepted | 177 | 141 |
| Accepted and correct | 177 | 141 |
| Accepted and wrong | 0 | 0 |
| Refused, valid GF(2) streaming function (false refusal) | 95 | 149 |
| Refused, valid over Z/2^32 only (outside the class) | 10 | 10 |
| Refused, not valid (not composing, not affine, or address dependent) | 67 | 155 |

The false refusal rates are 95 of 349 (27%) for the stream checker and 149 of 455 (33%) for the loop
checker. Each checker refused every module of the other form, so no module was accepted by both.

106 of the 804 modules do not compose under the ground truth, and both checkers refused all 106. 12
more compose at fixed addresses and change when the bytes move; both checkers refused them too:
`c/addr-parity` at five optimization levels, `wrap/load-off1`, `wrap/load-ptr-plus-3`, `wrap/load16`,
`len/extra-when-ptr-aligned`, `len/ptr-parity`, `len/ptr-used-as-data` and `len/load-two-different`.
The 318 accepted modules are 303 distinct binaries; 134 of them are operator cases and 92 are fuzz
trees, and they include trivial functions such as the identity and the byte alone.

Checks on the 318 accepted modules:

- `recheck.json`: every byte value against 28 states at length 1, and 1,500 random runs of 2 to 15
  bytes at odd addresses with random cuts, per accepted module. 2,756,424 comparisons, 0 failures.
- Relocation: the recorded rows carry the field for 92 modules. The operator and fuzz rows predate the
  check, so the regeneration run supplies it for all 318: 0 failures.
- `big.json`: all 318 at 1,048,576 bytes, chain and model, 0 failures. The original run printed its
  result without saving it, so this file comes from the regeneration run.

Bulk fuzz, in `fuzz.json`. The loops run for a wall-clock budget, so a rerun builds a different number of
modules.

| Fuzzer | Seed | Budget | Modules built | Accepted | Wrong |
| --- | --- | ---: | ---: | ---: | ---: |
| `fuzz2.ts`, random trees as stream and loop forms | `0x1badb002` | 50 s | 36,868 | 32,011 | 0 |
| `fuzz3.ts`, identity-wrapped pre and post xor constants, loop form | `0xfeedbeef` | 45 s | 17,761 | 6,690 | 0 |

`fuzz2.ts` checked each accepted module on all 256 byte values with 8 states plus 40 chained runs.
`fuzz3.ts` ran the full chain ground truth on every accepted module with differing constants and on every
fourth other accepted module, not all 6,690. It refused 5,204 equal-constant modules (`refusedEqual`).

## False Refusals

Grouped by the reason each checker recorded. These are valid by the black-box label, so a refusal here
costs coverage and not correctness.

Stream checker, 95 modules:

| Reason | Modules | What they are |
| --- | ---: | --- |
| unsupported step operation | 28 | operations outside the evaluator that are affine over GF(2): 14 operator cases (negate of a 2-bit or high-bit field, `rotl`, `rotr`, `and` of two non-constants, multiply by 4, `add` or `or` of disjoint bits and similar), 8 fuzz trees, 3 hand-assembled binaries, `rotl5` at -O2, -O3 and -Os |
| expected values to be strictly equal | 22 | the wrapper differs from the template: compiled wrappers at -O0 (10) and -O1 (10), a count-up loop and an extra unused local |
| step must be pure supported arithmetic | 18 | a compiled step with a branch or select (-Os 5, -O2 1, -O3 1), six operator cases (`select`, popcount parity, `eqz` of a constant, `i32.wrap_i64`, `drop`, `if` on a constant) and five state cases where the step reads a global, writes memory, calls a helper or grows memory |
| initializing data segments | 10 | the table-driven nibble CRC at five levels and five modules with a data segment |
| strictly deep-equal | 4 | wrapper variants: a second exit on a constant pointer, signed byte load, swapped arguments, a teed pointer load |
| falsy value | 3 | multi-value blocks and a multi-value loop |
| unsupported wrapper expression | 3 | `br_table`, a store in the loop, a pointer increment through `tee` |
| nop crash | 2 | `nop` in the step or the wrapper (see below) |
| start function | 2 | an empty and a storing start function |
| imports | 2 | an imported no-op function and an imported global |
| memory sharing | 1 | shared memory |

Loop checker, 149 modules:

| Reason | Modules | What they are |
| --- | ---: | --- |
| local read before it is defined | 37 | 36 fuzz trees and one operator case that read a temporary carried across iterations |
| function shape | 28 | compiled -O0 (16), -O1 (5), -O2, -O3 and -Os (2 each) and one loop-state variant |
| statement outside the state | 20 | compiled -O2, -O3 and -Os kernels with extra scratch assignments, and one conditioning variant |
| operation | 19 | operations outside the evaluator, mostly operator cases |
| does not return the state | 12 | compiled -O1 (11) and one loop-state variant |
| data segments | 8 | the nibble CRC at five levels and three loop-state variants |
| expression | 6 | `select`, `if`, `eqz`, `wrap_i64`, popcount parity |
| no loop | 4 | xorshift and parity at -O2 and -O3, where the compiler removes the loop |
| statement kind in the loop | 3 | `drop`, a store, a call whose result is unused |
| load other than the input byte | 2 | signed loads |
| start function, nop crash, no zero-length exit block | 2 each | |
| imports, non-i32 local, pointer or length used as data, conditioning not a state xor constant | 1 each | |

The Z/2^32 modules (`poly31` and `sum`, five optimization levels and both forms each) are
valid streaming functions outside the class by design.

## Robustness Finding

`binaryen.getExpressionInfo` throws a raw `TypeError` on a `nop` node. In the recorded run both
checkers propagated it, and `refusalOf` rethrows anything that is not a `Refusal`, so a caller got a crash
and not a refusal. The failure is closed: nothing is accepted. The same crash hit a `br_table` seen by the
loop checker. Both spike checkers now convert the failure into a refusal ("expression kind N has no
readable form"), and a unit test in `tests/unit/affine.test.ts` covers the nop case. The recorded
reasons in `modules.json` keep the original `TypeError` text for five modules: `ops/nop/stream`,
`ops/nop/loop`, `wrap/nop/stream`, `wrap/br-table/stream` and
`loopstate/guard-inside-extra-pre-stmt/loop`.

## What This Does Not Cover

This is evidence about the shapes the generators produce. It is not a soundness argument, and the
arguments for the hazards tried are the author's own.

- Lengths above 2^20, wraparound at 2^32, pointer wrap and the trap at the end of memory. `guardInput`
  was not exercised.
- Concurrency: a racing writer on shared memory, atomics, worker pools. Every claim is about one
  sequential instance.
- Proposals beyond the base set (SIMD, relaxed SIMD, tail calls, exceptions, GC, memory64,
  multi-memory, custom page sizes, threads). Only multi-value blocks were tried.
- Non-canonical binaries beyond the hand-assembled ones: padded LEBs, unusual section order, custom
  sections. V8 validation was the only gate.
- Resource exhaustion in the evaluators (deep nesting, symbolic blowup) and timing.
- One toolchain: clang on 24 small kernels and 15 loop-only shapes at five levels. No other compiler,
  no `-mbulk-memory`, no LTO, no `-fno-unroll-loops`. Neither checker accepted a compiled module at
  -O0 or -O1 (the accepted ones are 13 at -O2, 13 at -O3 and 9 at -Os), and this study does not
  examine why beyond the recorded reasons.
- Ground truth uses one fixed pseudo-random input per run, plus the fuzzers' other patterns. Nothing
  aims an input at a particular accepted kernel, for example to hit a rare-state trigger. The checkers
  refused every nonlinear step, so there was no accepted candidate to aim at.
- The validity label errs toward "not valid", so some refusals counted as correct may be valid, and the
  false refusal counts are a lower bound.
- Model claims for widths other than 1, 2, 4 and 8 and for alignment above 1.
- The ground truth, the validity label and the generators share one author and one harness. There is no
  second implementation of the ground truth.
- The recorded operator and fuzz rows have no relocation field, and `big.json` and the relocation
  coverage of those rows come from the regeneration run, not the original run.
- The accepted set is small and skewed. 134 operator cases and 92 fuzz trees make up most of the 318
  accepted modules, and only 35 are compiled.
- The two spike checkers are baselines. A widened certifier needs its own run of this corpus.

## Reproduction

```sh
node scripts/research/redteam/run.ts build/research/redteam-run
node scripts/research/redteam/recheck.ts build/research/redteam-run
node scripts/research/redteam/big.ts build/research/redteam-run
node scripts/research/redteam/fuzz2.ts build/research/redteam-run
node scripts/research/redteam/fuzz3.ts build/research/redteam-run
```

`run.ts` runs `gen-ops`, `gen-wrapper`, `gen-loopstate`, `gen-raw` and `gen-c` in order, then
`summarize` (merge the `rows-*.json` files into `modules.json`) and `counts` (write `counts.json`).
Each script takes its output directory, writes the modules under `build/`, and refuses to overwrite
a file. `gen-c` needs clang; set `LLVM` to its directory if it is not at the Homebrew path. The
fuzzers take a second argument with the budget in milliseconds.

A regeneration reproduced every verdict of the 804 recorded modules and the binaries of the 311 raw
and compiled ones. It differs from the record in three ways:

- It lists 806 modules. `ops/ext8/stream` and `ops/ext8/loop` (`extend8_s` of the state) failed to
  build in the recorded run and have no row. Both are valid GF(2) functions that both checkers refuse,
  which makes the regenerated false refusals 96 and 150.
- The five modules named in the robustness finding carry the new refusal text.
- The operator and fuzz rows have the relocation field, empty for all accepted modules.

The record's `counts.json` reports 782 distinct binaries. The digests in `modules.json` give 788: the
earlier count rebuilt the modules with a custom memory declaration (`state/memory-shared`,
`state/memory-import`, `state/memory-small`, `state/memory-nomax`, `loopstate/memory-shared` and
`loopstate/memory-nomax`) with the default memory, which accounts for the difference of six.

## Artifacts

- `modules.json`: the 804 recorded rows, merged from the generators' `rows-*.json` files. The
  `moduleSha256` field comes from the regeneration; every other field is the recorded value.
- `counts.json`: the recorded tally, address-dependent list and false refusal causes.
- `fuzz.json`: the `fuzz2.ts` and `fuzz3.ts` results with their seeds and budgets.
- `recheck.json`: the second ground truth for the 318 accepted modules.
- `big.json`: the 1 MiB check from the regeneration run.
- `manifest.json`: byte lengths and SHA256 digests.
