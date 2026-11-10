# Bulk driver adapters

One C file per project (`<project>.c`) holds one adapter per driver, selected with `-DK_<NAME>`. The
shared parts are:

- `harness.h`: the record (`rec_t`), output slot macros and the input generator helper.
- `loop.h`: `bulk()` (the record loop) and `prepare()` (writes the record table and inputs). Each
  project file defines `GEN(i, dst)` and `one(rec, out)` and then includes `loop.h`.
- `native.c`: the native baseline `main`. It builds the same driver with the host clang and system
  libc, runs it once and writes every slot to a file.

The record and slot layout follows `scripts/research/cases/c21/bulk.c`. Each slot is `SLOT` bytes.
Word 0 is the return value, word 1 onward holds extra scalars, and the output bytes start at offset 32
(`DATA(out)`). Pointers and addresses never go into a slot.

## Memory and arenas

Every driver imports its memory (`env.memory`, unshared) and re-exports it as `memory`, the same ABI
as the development corpus (`imported-unshared`). The manifest `memory` field gives the initial and
maximum pages for the whole final corpus. The development corpus uses 128 and 1024; the final
corpus needs more because every record has its own arena slice (largest driver: 65 slices of 2 MiB).

`prepare(table, n, heap)` lays `heap` out as the record inputs (`n * recordCapacity` bytes, 64-byte
aligned), then `n` arena slices of `ARENA` bytes, then one more slice of `GEN_ARENA` bytes that the
input generators use while `prepare` runs. `table[i].arena` points at slice `i`. `one()` starts with
`bump_set(P(r->arena), ARENA)` when it allocates, and nothing zeroes an arena. The output slots
follow the heap. `layoutOf` in `build-drivers.ts` computes the same offsets.

`ARENA` is per driver in the manifest: the smallest power of two that is at least twice the largest
bump cursor any record reaches in the serial run, with a floor of 64 KiB. A driver that does not
allocate gets the floor and still has its slices laid out. `genArena` follows the same rule for the
generator slice, measured over `prepare` (the libdeflate decompress generators run the compressor,
668320 bytes, which is more than their records need). The native build lays out the same
slices and uses the system `malloc`, so its checksums do not depend on the arena.

## Candidate rule

A function is a candidate when all of these hold:

1. It is declared in a public header the project presents as its API, and the header is installed
   by the project's build or is the only API header in the tree.
2. It has at least one pointer parameter.
3. It has a non-pointer parameter of type `size_t` or `ssize_t`, or of any integer type whose name
   contains `len`, `size`, `count` or `length`, and that parameter comes after a pointer parameter.

Value parameters such as `uint64_t value` do not count. The rule was fixed before any driver
was built. Candidates are adapted in declaration order, the first 12 per project. A candidate
beyond the cap gets the reason `over-cap`.

The rule reads the parenthetical in the spec literally for `size_t` and for names. Under the
literal reading, every integer value after a pointer would count, so value setters such as
`cbor_encode_int` would become candidates. The result file lists every candidate with its status.

## Input generators

- Raw records use the dev default byte pattern `(j * 13 + (j >> 7)) & 255`, where `j` is the byte
  index. Record lengths vary with the record index, as the per-project file shows.
- Decode, decompress and parse drivers read streams made by the library itself, in `GEN`. The
  library's encoder or compressor runs once per record during `prepare()`, outside the timed loop.
- Structured inputs (JSON text, CBOR items, number arrays) are written by small generators in the
  project file. The generator for each driver is named in its project's `.md` file.

## Build and checks

`build-drivers.ts` compiles each driver with clang for `wasm32` against the shim
(`scripts/research/final-cases/shim`), links it with the shim objects and runs it through plain
`WebAssembly.instantiate`. It runs the native build with the host clang. Both sides hash every slot
with SHA-256. The serial Wasm loop runs three times. The script reports the median and the spread.

Folio does not run on any driver here. The timings measure the adapter loop on serial Wasm only.
They are not a Folio claim.

## Licence status and fallback candidates

Batch C projects are built and flagged, not cleared. Their manifest entries carry `licence: "pending"`,
and they stay outside the draw pool until the licence is decided:

- `picohttpparser`: no LICENSE file at the pin; the README states a Perl or MIT dual licence.
- `zstd`: BSD or GPL-2.0 at the user's option.
- `dr_libs`: Unlicense or MIT-0 at the user's option.
- `pffft`: LICENSE.txt has the NCAR/UCAR name clause.
- `picojpeg`: no LICENSE file at the pin; the header says public domain.

`pffft` and `picojpeg` have zero rule-1 candidates because of narrowness (no size parameter follows a
pointer), not a parse failure. They use the fallback rule 2 (non-static public functions with a
non-const pointer parameter). `siphash` has no public header in its tree, so it has no candidates
under either rule and no manifest entry.
