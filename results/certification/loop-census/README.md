# Loop Census

Question: how many real compiled streaming kernels does the spike loop checker certify, and what does
it refuse the others for?

The spike loop checker (`scripts/research/loop-check.ts`) accepts one pure loop with the step inlined,
one input-byte load, pointer and length used only as loop control, and a conditioning pair (the same
constant xored into the state before and after the loop) that must cancel across calls. This study runs
it on the compiled subjects of `scripts/research/cases/affine/subjects.c` and on miniz's own `mz_crc32`,
then counts the operations each module needs.

## Results

Nine real subjects, built with clang at -O2. The checker certifies one:

| Subject | Verdict | Recorded reason |
| --- | --- | --- |
| crc32c | certified | none |
| crc16 | refused | function shape |
| crc64 | refused | entry shape |
| poly31 | refused | statement outside the state |
| lcg | refused | statement outside the state |
| fnv1a | refused | statement outside the state |
| adler32 | refused | function shape |
| sha256c | refused | data segments |
| miniz-crc32 | refused | data segments |

For crc32c the certified model matches the sampling probe's operator, the conditioning constant is
`ffffffff`, and 112 of 112 comparisons agree. Each comparison folds a call over seven lengths (0, 1, 2,
31, 257, 65,537 and 262,144 bytes) from four start states at widths 1, 2, 4 and 8 through `predictEnd` and
checks the result against one serial call (7 x 4 x 4 = 112).

Two negative controls edit the crc32c module and must be refused. Removing the post-loop conditioning
and replacing its constant with a different one are both refused with "conditioning does not cancel
across calls".

The refusal strings come from `loop-check.ts`. `data segments` (sha256c, miniz-crc32) means the module
has an initializing data segment. `function shape` (crc16, adler32) means the function body is not a
guard block followed by a return of the state. `entry shape` (crc64) means the entry does not take
three i32 parameters; crc64 carries a 64-bit state. `statement outside the state` (poly31, lcg, fnv1a)
means a statement in the loop assigns something other than the state local. The record names the first
check that failed, so it does not say whether a refused subject is a valid streaming function.

## Operation Histograms

`classes.json` is a static count over the text form of each module. `ops` is the twelve most frequent
operations.

| Subject | Loops | Loads | Data segments | Multiply | Remainder or divide | 64-bit | Top operations |
| --- | ---: | ---: | ---: | --- | --- | --- | --- |
| crc32c | 1 | 1 | 0 | no | no | no | const 34, xor 11, and 9, shr_s 7, shl 7 |
| crc16 | 2 | 7 | 0 | no | no | no | const 57, and 22, xor 14, shr_u 11, sub 8 |
| crc64 | 2 | 7 | 0 | no | no | yes | const 57, xor 16, and 14, shl 10, shr_u 10 |
| poly31 | 2 | 5 | 0 | yes | no | no | const 16, add 13, mul 5, load8_u 5 |
| lcg | 2 | 5 | 0 | yes | no | no | const 18, add 15, mul 5, load8_u 5 |
| fnv1a | 2 | 5 | 0 | yes | no | no | const 16, add 8, mul 5, xor 5, load8_u 5 |
| adler32 | 1 | 3 | 0 | no | yes | no | const 16, add 10, rem_u 6, and 3, load8_u 3 |
| sha256c | 4 | 7 | 1 | no | no | no | const 44, add 26, xor 14, rotl 10, load 7 |
| miniz-crc32 | 1 | 14 | 1 | no | no | no | const 33, xor 16, shr_u 7, load 7, shl 7 |

No subject uses SIMD, `select` or `if`. The single-loop, single-load crc32c is the only module shaped
like the checker's template. poly31, lcg and fnv1a have two loops and five loads of the input byte
each, which fits an unrolled main loop followed by a tail loop; the census does not show the unroll
factor. The crc16 and crc64 sources build their 256-entry table on first call (`subjects.c`), which
accounts for their second loop and the store. adler32 keeps two 16-bit sums in one 32-bit word and
reduces both with `rem_u`. A certifier that covers more of these modules therefore needs to prove an
unrolled main loop equal to its tail step, to accept lazy table initialization that runs once, and to
track packed state.

## Reproduction

```sh
node scripts/research/affine-build.ts
node scripts/research/loop-census.ts build/research/loop-census.json
node scripts/research/class-census.ts build/research/class-census.json
cmp build/research/loop-census.json results/certification/loop-census/loop-census.json
cmp build/research/class-census.json results/certification/loop-census/classes.json
```

The first command builds the eight C subjects and downloads the pinned miniz archive (see
`scripts/research/corpus-manifest.json`) when `build/research/corpus/miniz.tar.gz` is missing. Without
that archive both scripts list eight subjects and omit `miniz-crc32`. Both scripts refuse to overwrite
an existing output file. A rerun produced byte-identical files.

## Artifacts

- `loop-census.json`: verdicts, reasons, conditioning constants, operator check and comparison count per
  subject, plus the two negative controls.
- `classes.json`: the static operation census per subject.
- `manifest.json`: byte lengths and SHA256 digests.

## Scope and Limits

The subjects are nine kernels from one source file and one library, compiled by one toolchain at one
optimization level. The census says what the spike loop checker refuses, not what a wider checker
would accept. Operation counts come from a text match over the module and count instructions, not
executed operations. The 112 comparisons run on one pseudo-random 262,144-byte input.
