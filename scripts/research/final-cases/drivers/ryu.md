# ryu drivers

Pin: `v2.0`, commit `72e18e8d`. Licence: Apache-2.0 or BSL-1.0 (`LICENSE-Apache2`, `LICENSE-Boost`). Source:
`upstream/ryu/ryu/` (the closure of the four translation units, verbatim).

## Candidates

Rule 1 gives 0: no `ryu.h` function has an integer length after a pointer. Rule 2 applies (zero under rule 1
because of the rule's narrowness, not a parse failure; `ryu.h` has no unparsed items). Four non-static
functions in `ryu/ryu.h` take a non-const pointer: `d2s_buffered_n`, `d2s_buffered`, `f2s_buffered_n`,
`f2s_buffered`. The `d2s` and `f2s` functions return `char *` and take no pointer, so they are not candidates.

`ryu/ryu2.h` is not in the header list. It declares `d2fixed_buffered_n`, `d2fixed_buffered`, `d2fixed`,
`d2exp_buffered_n`, `d2exp_buffered` and `d2exp`, all taking a non-const `char *`. They are missing from the
candidate set. The header list is the main session's to correct.

## Generators

Dyadic doubles and floats (`mix` of the record index, scaled by a power of two), so each value is exact on
both targets.

## Build status

The `d2s` path uses `__uint128_t` (`HAS_UINT128`), so wasm32 needs `__multi3` and `__lshrti3`. Both come from
the shared shim (`shim/builtins/`, vendored from compiler-rt), so all four drivers build and match native. The
`d2s` drivers were `build: failed` before the shim had these builtins. `RYU_ONLY_64_BIT_OPS` was not used.

## Outputs

The string length in word 0. The string itself is in the data area (`d2s_buffered` and `f2s_buffered` write
a NUL terminator, the `_n` variants do not).
