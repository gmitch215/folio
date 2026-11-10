# pffft drivers

Pin: `v1.2.0`, commit `5055b930`. Licence pending: `LICENSE.txt` has the NCAR/UCAR name clause, which needs a person to read. The manifest entry is `licence: pending`.

## Candidates

Rule 1 has zero candidates, and this is narrowness, not a parse failure. The enumerator parsed all 44 declarations with no unparsed lines, and none of them has a size or length parameter after a pointer. The fallback rule 2 applies: non-static functions in the public headers with at least one non-const pointer parameter. That gives 22 candidates, 11 from `pffft.h` and 11 from `pffft_double.h`. The first 12 in enumeration order are adapted. The other 10 (the `pffftd_*` functions after `pffftd_destroy_setup`) are recorded as `over-cap`.

## Configuration

- `PFFFT_SIMD_DISABLE` is set on both sides. Without it the native arm64 build uses NEON and the wasm build uses scalar code, which computes the same transform in a different order.
- `-ffp-contract=off` is set for the native build only, for the same reason as dr_libs.
- The translation units are `src/pffft.c`, `src/pffft_common.c`, `src/pffft_double.c` and `src/fftpack.c`.

`pffft.c` computes its twiddle table with the libm `cosf` and `sinf`. On wasm those are the shim's musl functions, and on native they are the system libm. The two may differ in the last bit, which would show up as a checksum mismatch. The result file records whether it does.

## Generators

- `gen_cplx`: 128 floats (2 * 64) from the dev pattern, offset by the record index.
- `gen_two`: 256 floats (4 * 64), used by the two-operand convolutions.

Both use values in [-1, 1) so no conversion sees NaN.
