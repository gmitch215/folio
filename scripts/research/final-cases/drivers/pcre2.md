# pcre2 drivers

Pin: `pcre2-10.49`, commit `6f9d7c13`. Licence: BSD-3-Clause with the PCRE2 exception, `LICENCE.md`. Source:
`upstream/pcre2/src/` (the 32 translation units of the CMake library list and their headers, verbatim).
`pcre2_chartables.c` is a copy of `pcre2_chartables.c.dist`, which is what the CMake build generates by default.

## Build

`HAVE_CONFIG_H` is set, and the config wrappers in `config/pcre2/` supply `PCRE2_CODE_UNIT_WIDTH 8` and
`pcre2.h`. The wrappers include the pinned `pcre2.h.generic` and `config.h.generic` from `src/`. JIT is off.

## Candidates

Rule 1 gives 2: `pcre2_regexec` and `pcre2_regerror`, both in `src/pcre2posix.h`.

The header list is wrong for this project. `src/pcre2.h.generic` gives 0 functions and 20 unparsed items. Its
API sits inside object-like macro bodies (`PCRE2_GENERAL_INFO_FUNCTIONS` and similar), which the enumerator does
not expand. So `pcre2_compile`, `pcre2_match` and the rest of the core API are not in the candidate set. The
candidate set here covers only the POSIX wrapper. This was not patched by hand. The main session has to decide
how to enumerate the generated header.

## Generators

- `pcre2_regexec`: a NUL-terminated subject of letters, digits and spaces, up to 127 bytes. The regex
  `([a-z]+)([0-9]+)` is compiled inside each record, so the record is stateless.
- `pcre2_regerror`: the error code is 1 to 17 from the record. A compiled regex is passed as `preg`.

## Outputs

`pcre2_regexec` writes the return code and the three match offset pairs. `pcre2_regerror` writes the returned
length, and the message goes in the data area.

## Limits

- The match array is initialised to -1. An earlier draft left it uninitialised; a non-matching subject then gave
  Wasm runs that disagreed with each other.
- Memory comes from the record's own arena slice, set at the start of `one()`.
