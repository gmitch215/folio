# Stream Certifier

Question: can a checker prove, from the module bytes alone, that a stream function is the fold of one affine byte step for every length and every split, on the loop shapes compilers emit, and what does it refuse?

`certifyStream` in `src/certify.ts` takes a module and an export `entry(state, ptr, len)`. It returns a certificate that the entry equals the left fold of one affine byte step over the input for every state, every pointer and every length of at least one byte, with the step's state operator as the model, or the reason it refused. The proof runs the function symbolically. Lengths below a block run one by one, and every other length runs as `block * q + r` with `q` symbolic and each remainder `r`. A loop whose trip count depends on `q` is summarized by induction: the loop body must equal the byte step applied once per stride, and the trip count comes from the exit test. Tables read at fixed addresses, tables the first call builds, internal calls and 64-bit states are executed or read concretely. A byte may pass through any pure function; the state must pass through GF(2) operations (xor, and, shifts, rotates), Z/2^w operations (add, multiply by a constant) or, for a 32-bit state of two 16-bit digits, residues mod one constant p (`rem_u` by p, with exact integer forms bounded below 2^32). A nonlinear function of the state, such as the top byte of an LCG state or a table indexed by the state, is kept as an opaque atom that may only reach memory. A kernel that rewrites its input in place gets an `output` proof: byte i becomes a fixed function of the original byte and the fold state before it, the bytes written tile the input exactly, and no byte is read after it was written. `block` defaults to a ladder of 4 and then 16, and `maxMs` (30 s by default) covers the whole call. The earlier [spike checkers](../checker-redteam/README.md) accepted one loop skeleton or one inlined loop and had no length proof.

## Real Subjects

Fourteen compiled subjects, clang -O2. Ground truth is execution on real instances at lengths from 1 byte to 1 MiB, four input patterns, five start states (including digits above the modulus), chains at several cuts, the model at 2, 3, 5 and 8 chunks, a second call on the same instance and shifted pointers (`scripts/research/certify-ground.ts`). For the kernels that rewrite their input it also compares the bytes after one call, after two calls cut anywhere and after chunks run in reverse order from the states a serial run reaches, and checks that nothing outside the input changes. Certification time is from the [cost study](../../execution/certified-cost/README.md) and its [widened repeat](../../execution/certified-cost-widened/README.md) on the Ryzen rig; `subjects.json` records the times of the run that wrote it, on a loaded laptop.

| Subject | Verdict | Ring and width | Zero-length call | Certify ms | Ground truth |
| --- | --- | --- | --- | ---: | --- |
| crc32c | certified | GF(2), 32 | state unchanged | 7.0 | agrees |
| crc16 | certified | GF(2), 32 | transforms the state | 103 to 105 | agrees |
| crc64 | certified | GF(2), 64 | state unchanged | 626 to 629 | agrees |
| poly31 | certified | Z/2^w, 32 | state unchanged | 2.2 to 2.7 | agrees |
| lcg | certified | Z/2^w, 32 | state unchanged | 1.8 | agrees |
| miniz-crc32 | certified | GF(2), 32 | state unchanged | 93 to 99 | agrees |
| adler32 | certified | residues mod 65,521, 32 | state unchanged | 2.6 to 3.3 | agrees |
| xlcg (in place, LCG keystream) | certified, output | Z/2^w, 32 | state unchanged | 4.0 | agrees, bytes agree |
| xshift (in place, xorshift32) | certified, output | GF(2), 32 | state unchanged | 3.8 | agrees, bytes agree |
| xsbox (in place, xorshift32 and a 256-entry table) | certified, output | GF(2), 32 | state unchanged | 11.7 | agrees, bytes agree |
| xfeed (in place, state reads the bytes) | certified, output | Z/2^w, 32 | state unchanged | | agrees, bytes agree |
| fnv1a | refused: product by a constant that is not a power of two | | | | |
| sha256c | refused: writes the stack pointer global, and the compression is not affine | | | | |
| miniz-adler32 | refused: a counted loop inside a counted loop (zlib's 5,552-byte blocking) | | | | |

All seven valid affine subjects are certified, and so are the four in-place kernels. FNV-1a and the SHA-256 compression are not affine, so their refusals are correct. miniz's own `mz_adler32`, compiled by clang with the zlib blocking, is a valid fold that the checker refuses; the certified Adler-32 is the per-byte reduction. crc16 and crc64 build their table on the first call, and the certificate carries the bytes of that build (`initialization`) and the byte ranges an input must avoid (`exclusions`). The unrolled main loop with a tail loop is what clang emits for poly31, lcg, miniz-crc32, crc16 and crc64, and each of them certified through the summary of the loop. The `xfeed` state reads the bytes it rewrites, so its certificate has no `step` and chunks cannot start without the ones before them. `subjects.json` has the certificate fields, including the exclusion ranges, the output field and the work counters.

## Constructed Hazards

The 21 modules of the [split-sensitivity study](../split-sensitivity/README.md): 14 differ from the unsplit call at some length, and 7 compose.

| Group | Modules | Certified | Refused |
| --- | ---: | ---: | ---: |
| Split-sensitive, including every length trigger from 1,000 to 262,144 | 14 | 0 | 14 |
| Compose and affine over GF(2) or Z/2^w | 4 | 4 | 0 |
| Compose, affine over Z/65521 | 1 | 1 | 0 |
| Compose, not affine | 2 | 0 | 2 |

The five certified are the control, the index-counted equivalent wrapper, the multiplicative hash, the table-driven CRC-32 and the Adler-32; the spike stream checker accepted only the control. Every length trigger is refused because a branch on the length is not decided by the lengths the proof covers.

## Red Team Corpus

The 804 modules of the [red-team study](../checker-redteam/README.md) with its recorded validity, run through the certifier. A module is valid when it is an affine fold; the recorded table says which are.

| Class | Modules |
| --- | ---: |
| Valid, certified | 506 |
| Valid, not certified, within the class | 13 |
| Valid, not certified, outside the class | 75 |
| Not valid, refused | 208 |
| Not valid, certified | 2 |

Of the 75 outside the class: 40 keep state in linear memory, globals or tables (unoptimized builds, a stack pointer), 12 use module features the checker refuses (a start function, imports, passive segments, shared memory), 8 use the pointer or the length as data, 7 depend on the alignment of the pointer, 5 read outside their input and 3 write memory while they fold. Refusals are assigned to a class by the reason string of the ring that fits the module (`certify-redteam.ts`). The 13 refused within the class are the false refusals: 13 of 519, 2.5%. The spike checkers certified 177 (stream form) and 141 (loop form) of the 594 valid modules and refused 95 of 349 and 149 of 455 valid GF(2) modules in their form, 35% and 51%; these two rates use different denominators from the 2.5%.

The two certified modules recorded as not valid are `wrap-pre-post-xor-stream`, which transforms the state on a zero-length call (the recorded chain test includes it and the certificate excludes it, and its non-empty chains agree), and `len-store-input-loop`, which stores the low byte of its state over each input byte. The recorded table calls the second invalid because it writes memory, and the output proof now certifies it as an in-place rewrite whose bytes agree with execution; before the output proof it was refused. The certifier ran as well on 292 modules that the recorded table has no row for, and certified 126 of them, with every ground truth agreeing. No certified module in all 1,096 disagrees with execution.

## Second Round

An adversary with a fresh brief, a different generator family and read access to the checker built 1,321 modules with distinct digests: 240 from 60 new C kernels at four optimization levels, 78 one-literal mutants of accepted kernels, 331 random expression modules over six loop shapes, 56 hand-written adversarial shapes and 616 mutants of accepted modules (`adversary-modules.json`). The checker accepted 542 and refused 763. Before any fix the adversary found two accepted modules whose certificates were false, both from two active data segments that overlap: the checker read the first segment's byte and WebAssembly applies the last. That is fixed (the last segment wins) and covered by a unit test. After the fix, all 542 accepted modules were accepted and correct. A pass over all 1,321 with the checker as it stands after the third round accepts 546: the same 542 and four more, which the residue ring and the opaque atoms certify. The four and a seeded 10% sample of 54 of the earlier acceptances were judged, 58 in all, and all are correct (`adversary-final.json`). Of the 763 refusals, 362 compose on sampled chains. They were not checked for affine validity. One of them is confirmed valid: a reversed-order loop that the checker refuses because its loads advance forward only. Sixteen modules did not return within the harness limit; the certifier refused all sixteen, because a mutation made the pointer step an xor and the loop never exits. The adversary and the checker's author are the same model family.

## Code Review

A reviewer who did not write the checker read all of `src/certify.ts` and `src/certified.ts` for soundness and tried to build counterexamples. It confirmed three bugs, all fixed with regression tests: overlapping data segments (also found by the adversary), a data copy that a head-test loop left behind when it ran zero times, and modules with more than one memory, whose second memory was read as the first. Differential fuzzers over loop summaries (programs with random bodies over three locals in head and tail loops, and 8,748 loops with counters near 2^31 and 2^32) found 9 to 17 wrong accepted programs per seed for the zero-trip bug before the fix. After the fix the reviewer ran 12,000 programs and the author 9,000 more on the final checker, with none wrong, and the loop-counter fuzzer found none wrong. Two denial-of-service shapes took 290 s and 368 s before refusing (store loops, atoms made per iteration); the analysis now has an expression budget, a 30 s limit, a 64 KiB cap on initialization writes and a cap on atoms, and the same two modules refuse in 0.3 s and 5.9 s. A guard for a counted loop nested inside a counted loop was added after the reviewer found that the nesting restored a stale state. The reviewer listed six plausible gaps it could not exploit; the main one is that the trip-count argument depends on 32-bit wraparound facts it did not prove for numeric operands.

## Third Round

The residue ring, the opaque atoms of the state and the output proof had their own review: an adversary with a fresh brief and a code reviewer, both of the author's model family, each without sight of the other's work (`adversary-round3.json`). The adversary built 3,517 modules, 3,492 distinct by digest, in seven families: residue kernels in C at -O1 to -Os (block and per-byte reduction, conditional subtract, runtime and oversized moduli, Fletcher, a third sum, tail-only reduction), residue kernels in WAT (197 hand mutations of Adler-32 and 350 random expression trees), in-place kernels in C (LCG, xorshift, counter and S-box keystreams, CBC feedback, index, pointer and length keys, stores of 16 and 32 bits, reverse order, neighbours, read-back, swaps, a tail with a wrong key, 64-bit states), in-place kernels in WAT (store before load, double stores, stride mismatches, stores behind length tests, `memory.fill` and `memory.copy`, a second function that stores, plus 350 random keystream and state combinations), nonlinear state functions that reach the state, a branch, an address, a loop bound or a store address, one-change mutants of 30 accepted bases (1,199), and 80 hand-built offset attacks.

At the time, the checker accepted 991 of them, 916 correct and 75 wrong. None of the 75 touches the three new mechanisms: all are one older fault. The checker added the offset immediate of a load or store to the address as a 32-bit control value, which wraps, while WebAssembly adds it as a 33-bit sum and traps past the end of memory. `s * 31 + load8_u offset=1 (p + i - 1)` is accepted with no exclusions and traps at pointer 0; with `offset=4294967295` it traps at every pointer. The first version of the fix still accepted `offset=4294967295`, so the checker now reads the immediate as an unsigned 32-bit value before comparing, and refuses any access whose immediate exceeds its checked position. The earlier ground truth ran every module at pointer 1 MiB only. The adversary's check also runs pointers 0 to 256 and the end of memory, and found no further failure among the 916 correct ones. After the fixes all 3,492 distinct modules were certified again: the 913 distinct correct acceptances stay accepted, the 75 wrong ones are refused and no refused module is newly accepted. Of the 3,492, 196 refusals compose and are valid folds: 112 are zlib-style blocked loops (a counted loop inside a counted loop), 51 are residue blocks with modulus 2 or 65,536 that report `Add may carry`, and 15 are compiled select code that branches on data. A further 41 output kernels write without reading the byte and are refused because the folded bytes differ from the length.

A negative control checked 11 certificates against modules they do not describe and caught 9. The two it missed share their state fold with the certified module and differ in the stored byte, so the ground truth tests that bytes are consistent across cuts and chunk orders and cannot test the value of `out1`. A self-consistent wrong byte function would pass it.

The code reviewer found one false certificate by reading `check`. The comparison that substitutes the one-byte image put its byte at input position 100, which a block of 64 reaches: a stride-1 loop of `64Q - 63` iterations leaves a tail of `r + 63` bytes, and a tail term in the state and byte 100 then cancelled in the substitution. The kernel (`s = 2 * s + byte` with a final `(t + e) << 31`) certified with `block: 64` and differed from the fold by 2^31 at lengths 102, 103, 120, 127 and 166. The image byte now sits at position 900, above every input position and placeholder. The reviewer also showed that `maxMs` did not bound the analysis (a chain of squares or of residues took 62 to 84 s against 30 s), that `guardInput` accepted a length of 2^32 and that an unknown `ring` option threw. The limit now covers the whole call and the atom walks are memoized; a data segment whose offset is an extended-constant expression is refused instead of throwing. Two gaps the reviewer could not exploit were closed: the covered bytes of a loop may not reach 2^32, and `zpSplit` checks its argument fits. About 1,900 zp and atom certificates and 350 in-place certificates from the reviewer's fuzzers, and `zeroRun` against the real kernel for three rings, had no mismatch. Both reviewers broke the rule against editing scratch files with shell tools; no tracked file was affected.

## Scope

A certificate is a claim about the module bytes under stated preconditions: the input lies in memory, avoids `exclusions`, and the bytes in `image` hold their recorded values. The checker proves a property of one function in one module with no start function, no imports and one memory. It does not prove that the kernel is correct or that other exports leave memory alone. A call over zero bytes is outside the fold claim; the certificate records what such a call returns. The ground truth in this study is execution on sampled inputs and cannot prove soundness. Each of the two adversary rounds and the two code reviews found a bug in this checker. That is evidence that another round would find more, and the certifier has not been formally verified. Blocked checksums (zlib's Adler-32), 64-bit residue state, state held in linear memory, writes that do not read the byte, writes through a second pointer and wider stores are not covered, and the value of the rewritten byte is checked only for consistency with the fold.

## Reproduction

From the repository root, after the corpus build for miniz (`scripts/README.md`) and `redteam/run.ts` for the module directory:

```sh
node scripts/research/certify-subjects.ts subjects.json
node scripts/research/certify-redteam.ts RUN_DIRECTORY ../checker-redteam/modules.json redteam.json
```

`certify-subjects.ts` writes the fourteen subjects and the 21 constructed modules with their ground truth. `certify-redteam.ts` certifies every module of a red-team run, runs the ground truth on each certificate and assigns each refusal to a class. The second-round generators and the reviewer's fuzzers are in `scripts/research/adversary/`; the module digests are in `adversary-modules.json`.

### Regenerating The Second Round

The generators write modules under a work directory, which stays out of the repository. The C kernels need clang with the wasm32 target (`LLVM` names the toolchain directory, as in `scripts/README.md`). From the repository root:

```sh
A=scripts/research/adversary
node $A/gen-clang.ts work
node $A/gen-wat.ts work
node $A/compare.ts work results/certification/stream-certifier/adversary-modules.json
```

`compare.ts` prints how many of the 1,321 digests are equal, different, missing and extra, and exits 1 on any difference. To rerun the checks, shard the modules over several processes and merge the rows:

```sh
for k in 0 1 2 3 4 5 6 7; do node $A/run.ts work judge $k 8 & done; wait
node $A/summarize.ts work
```

`summarize.ts` writes `work/modules.json` in the layout of `adversary-modules.json` and the counts in `work/summary.json`. The pass over all modules with the final checker certifies each one, selects the newly accepted modules and a seeded 10% sample of the earlier accepted set, and judges those:

```sh
for k in 0 1 2 3 4 5 6 7; do node $A/run.ts work certify $k 8 & done; wait
node $A/select-final.ts work results/certification/stream-certifier/adversary-modules.json
for k in 0 1 2 3 4 5 6 7; do node $A/run.ts work judge $k 8 work/final-judge-list.json & done; wait
node $A/summary-final.ts work
```

The reviewer's fuzzers take no setup. `fuzz-locals.ts SEED PROGRAMS` defaults to seed 1 and 3,000 programs, `fuzz-trips.ts` runs its 8,748 loops, and both exit 1 on a wrong acceptance. `robust-atoms.ts` and `robust-store.ts` print the seconds the checker takes to refuse each denial-of-service module.

```sh
node $A/fuzz-locals.ts 1 3000
node $A/fuzz-trips.ts
node $A/robust-atoms.ts
node $A/robust-store.ts
```

### Regenerating Round Three

Run everything from the repository root with Node 26 or later. Every script writes under `ROUND3_OUT` (`round3-out` in the working directory when unset), so the generated modules stay out of the repository. Set it once.

```sh
export ROUND3_OUT=round3-out
R=scripts/research/adversary/round3
```

The generators write the specs that are not written by hand. The C builds need clang from `LLVM` or Homebrew, and `wasm-opt` from `node_modules/.bin` is kept off the path.

```sh
node $R/gen-m.ts 40    # mutants of 30 base modules; prints 1199 and the count per base
node $R/gen-r.ts 700   # random residue and output kernels; prints 700
node $R/gen-x.ts       # offset immediate attacks and controls; prints 80
node $R/gen-y.ts       # 64 bit and wide intermediate kernels; prints 100
```

`digests.ts` builds every spec without certifying it, writes the modules to `$ROUND3_OUT/modules` and compares the digests with a manifest that has `id` and `sha256` per row. It prints `built 3518 specs, 3492 distinct modules` and then `equal 3517, different 0, missing 0, extra 0`. One id (`rw-adler/ok-tail`) is built twice from the same source. It exits 1 on any difference.

```sh
node $R/digests.ts path/to/modules.json
```

`run.ts SHARD COUNT [FAMILY_REGEX] [SECONDS]` certifies and checks one shard of the specs in worker threads and appends rows to `$ROUND3_OUT/results/shard-SHARD.jsonl`. It prints one line with the counts per verdict and `WRONG` for every acceptance that disagrees with execution. `LIMIT_MS` (default 60000) and `LANES` (default 2) set the per-module limit and the thread count. A full pass is six shards.

```sh
for s in 0 1 2 3 4 5; do node $R/run.ts $s 6 . 1500 & done; wait
```

After the shards finish, `recheck.ts` runs the pointer placement checks on the accepted rows and prints the rows run and the wrong count. `summarize.ts` prints the counts by verdict, family and ring, and with `manifest` writes `$ROUND3_OUT/modules.json`.

```sh
node $R/recheck.ts 0 1 600
node $R/summarize.ts manifest
```

`recert.ts` recertifies every distinct module of a manifest with the current checker. Run it in shards over the modules from `digests.ts`, then merge. The merge prints one line per verdict transition and exits 1 when a module recorded as a wrong acceptance is still accepted. Against the recorded manifest it prints `75 ACCEPTED-WRONG -> refused`, `913 accepted-correct -> accepted`, `2324 refused -> refused` and `180 refused-valid -> refused`.

```sh
for s in 0 1 2 3 4 5; do node $R/recert.ts $s 6 recert-$s.json path/to/modules.json & done; wait
node $R/recert.ts merge recert-{0,1,2,3,4,5}.json
```

`control.ts` checks the ground truth against certificates of other modules (needs `bun run build:c`) and prints one line per pair. It exits 1 when a genuine pair fails or a mismatched pair passes, apart from the two that share the state recurrence. `repro-offset.ts` builds the two offset immediate modules that trap, prints the checker's refusal for each and exits 1 if either is accepted.

```sh
node $R/control.ts
node $R/repro-offset.ts
```

The reviewer's fuzzers sit one directory up. Each prints the counts of certified and refused modules and exits 1 on a wrong acceptance or a mismatch. Failing kernels are written to the directory named last.

```sh
A=scripts/research/adversary
for m in digits whole atoms; do node $A/fuzz-residue-atoms.ts 1 200 $m $ROUND3_OUT/fuzz-fails; done
node $A/fuzz-output.ts 1 200 $ROUND3_OUT/fuzz-fails
node $A/zero-run.ts
```

The expected result on the current checker is zero mismatches in each: `certified 26, refused 174` for `digits`, `92` and `108` for `whole`, `78` and `122` for `atoms`, `66` and `121` for `fuzz-output.ts`, and `zeroRun mismatches 0` for all four kernels of `zero-run.ts`.

## Artifacts

- `subjects.json`: the real subjects and the 21 constructed modules with certificate fields and ground truth. The timings in it were taken on a laptop while other work ran, so the certification times above come from the cost study.
- `redteam.json`: one row per module of the run, with the verdict, the ground truth and the class of each refusal.
- `adversary-modules.json`: the 1,321 second-round modules with digest, family, verdict before the fix and ground truth.
- `adversary-final.json`: the counts of the pass over the second-round modules with the checker as it stands after the third round.
- `adversary-round3.json`: the 3,517 third-round modules with digest, family, ring, the verdict at the time and the verdict after the fixes, and the counts.
- `manifest.json`: byte lengths and SHA256 digests.
