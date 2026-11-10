# Freestanding libc shim

This directory holds a small C library surface for compiling third-party C to WebAssembly (wasm32) without a host libc. It has three parts: headers under `include/`, one implementation file `shim.c`, and vendored math from musl under `musl/`.

The shim is compile-checked against candidate projects with clang flags matching `scripts/research/corpus.ts`. Build a unit with the shim headers on the include path:

```sh
clang --target=wasm32 -O2 -g0 -ffreestanding -fno-builtin -nostdlib -mbulk-memory -DNDEBUG \
  -I scripts/research/final-cases/shim/include -c source.c
```

Link `shim.c` and the files in `musl/src/math/` into the same module. `tests/unit/final-shim.test.ts` shows a complete build.

## Memory

`malloc`, `calloc` and `realloc` allocate from the slice last given to `bump_set(base, size)`. The shim has no static arena. `base` must be 16-byte aligned. `bump_set` rewinds the cursor and zeroes nothing, so `calloc` zeroes its own block and `realloc` copies. Each block has a 16-byte header that stores its size. Blocks are 16-byte aligned. `free` does nothing. A request larger than the remaining slice returns `NULL`, and so does any request before the first `bump_set`.

A driver gives every record its own slice and calls `bump_set(record arena, ARENA)` at the start of `one()`, so two records never allocate at the same address. The per-driver `ARENA` size and the layout are in `drivers/README.md`.

## Stubs

Calls that need the host return a failure value and set `errno` to `ENOSYS` (38) unless the table says otherwise.

| Functions                                                                                                                | Behavior                                      |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| `printf`, `fprintf`, `vprintf`, `vfprintf`, `puts`, `fputs`, `fputc`, `putc`, `putchar`                                  | return -1                                     |
| `fopen`, `fgets`, `fread`, `fwrite`, `fgetc`, `getc`, `ungetc`, `fclose`, `fflush`, `fseek`, `ftell`, `rewind`, `sscanf` | return a failure value (`NULL`, 0, `EOF`, -1) |
| `feof`, `ferror`                                                                                                         | `feof` returns 0; `ferror` returns 1          |
| `getenv`, `realpath`                                                                                                     | return `NULL`                                 |
| `exit`, `abort`                                                                                                          | trap (`__builtin_trap`)                       |
| `time`, `clock`, `mktime`, `clock_gettime`, `gettimeofday`                                                               | return -1                                     |
| `gmtime`, `localtime`                                                                                                    | return `NULL`                                 |
| `strftime`                                                                                                               | returns 0                                     |
| `difftime`                                                                                                               | returns the difference of its arguments       |
| `getpid`, `open`, `close`, `read`, `write`, `stat`, `fstat`                                                              | return -1                                     |
| `isatty`                                                                                                                 | returns 0                                     |
| `wcrtomb`, `mbrtowc`, `wcstombs`, `wcsrtombs`                                                                            | return `(size_t)-1` (no locale conversion)    |
| `strerror`                                                                                                               | returns `"unknown error"`                     |

`pthread_create`, `pthread_join`, the mutex and condition-variable functions, and `pthread_once` return `ENOSYS` as a value and do not run the routine passed to `pthread_once`. Attribute and condition-attribute setup (`pthread_attr_*`, `pthread_condattr_*`) returns 0 and has no effect, because the attribute objects are only read by calls that fail. A caller that ignores these return values proceeds without the lock or the one-time initialization.

## Strings and Numbers

`memcpy`, `memmove`, `memset`, `memcmp`, `memchr`, the `str*` functions listed in `include/string.h`, `strdup` and the ctype functions behave as in C with the C locale.

`strtol`, `strtoul`, `strtoll`, `strtoull` and `atoi`/`atol` accept leading whitespace, a sign, and bases 0 and 2 to 36. Overflow sets `ERANGE` and returns the limit.

`strtod` and `atof` implement a fast path only. The result is exact when the input has at most 15 significant digits and a decimal exponent in the range -22 to 22, because both operands are exact and one rounding applies. Any other decimal input returns 0 with `ERANGE` and `endptr` set to the start of the string. `inf`, `nan` and hexadecimal input return 0 with `EINVAL`.

`qsort` is a heapsort. It is not stable and does not allocate. `bsearch` is the usual binary search.

## Formatting

`snprintf`, `sprintf`, `vsnprintf` and `vsprintf` support these conversions: `%d %i %u %x %X %c %s %g` and `%%`. Flags `-` and `0`, a width, and `*` for width are supported. Length modifiers `l`, `ll` and `z` are supported. A precision is accepted for `%s` and `%g`. A precision on an integer conversion, an unknown conversion, or a precision above 700 returns -1 with `EINVAL`. `%f`, `%e` and `%a` are not implemented.

`%g` prints the exact decimal expansion of the double, rounded to the requested number of significant digits with round-half-even on exact ties. The unit test compares output with `Number.prototype.toExponential` and `toFixed`, which are exact in the specification, and it avoids exact ties. Output above the buffer size is truncated, and the return value is the full length.

## Math

The following come from musl v1.2.5 under `musl/src/math/`: `sinf cosf sin cos powf pow logf log expf exp ldexp scalbn`. The file list is in `musl/src/math/`; each file is a verbatim copy of the pinned source.

`sqrt`, `sqrtf`, `fabs`, `fabsf`, `floor`, `floorf`, `ceil`, `ceilf` and `copysign` use the WebAssembly builtins.

`isnan`, `isinf`, `isfinite`, `signbit` and `fpclassify` are macros over the clang builtins.

The musl source gives worst-case error bounds for `log`, `logf`, `exp`, `expf`, `pow` and `powf`. It gives no bound for `sin`, `cos`, `sinf` and `cosf`. The unit test checks these functions against `Math.*` within a fixed number of ULP, and the measured values are in the result file for the lane.

## Vendored Sources

| Item           | Value                                                                                               |
| -------------- | --------------------------------------------------------------------------------------------------- |
| Project        | musl libc                                                                                           |
| Upstream       | `git.musl-libc.org/git/musl`                                                                        |
| Tag            | `v1.2.5`                                                                                            |
| Commit         | `0784374d561435f7c787a555aeab8ede699ed298`                                                          |
| Licence file   | `musl/COPYRIGHT`, SHA-256 `f9bc4423732350eb0b3f7ed7e91d530298476f8fec0c6c427a1c04ade22655af`        |
| Vendored files | `musl/src/math/*.c`, `musl/src/math/*.h`, `musl/src/internal/libm.h`, `musl/arch/generic/fp_arch.h` |

The `*.c` files under `musl/src/math/` are the complete set this shim compiles. `libm.h` and `fp_arch.h` are the internal headers those files include.

## Shim Headers

`include/features.h` defines `weak`, `hidden` and `weak_alias` with the same definitions as musl's `src/include/features.h`. `include/math.h` declares the functions above and the `float_t` and `double_t` types for `FLT_EVAL_METHOD` 0.

`include/pthread.h`, `include/wchar.h`, `include/unistd.h`, `include/fcntl.h` and `include/sys/stat.h` declare the stubs listed above. `include/time.h` declares `struct timespec` and `clockid_t`, and `include/assert.h` defines `static_assert` as `_Static_assert`.

## Compiler-Rt Builtins

`builtins/` holds three 128-bit helpers that clang emits as calls on wasm32: `__multi3`, `__lshrti3` and `__ashlti3`. They are vendored verbatim from llvm-project commit `ea7d852a70e8bdfaf601d6626a760f9771b2c4b4`, `compiler-rt/lib/builtins/`, with the headers they include (`int_lib.h`, `int_util.h`, `int_types.h`, `int_endianness.h`). The `multi3.c` SHA-256 matches the value recorded for the development corpus in `scripts/research/corpus-manifest.json`.

Licence: Apache-2.0 WITH LLVM-exception, in `builtins/LICENSE.TXT` (SHA-256 `8d85c1057d742e597985c7d4e6320b015a9139385cff4cbae06ffc0ebe89afee`). The builtins are linked into every driver through the shared shim objects, not per project.

The checks are in `tests/unit/final-shim.test.ts` and compare each helper with BigInt on a fixed input set.

## Config Headers

Each directory under `config/` holds the minimal defines for one project. The values come from the project's own template at the pinned commit.

| Project  | Files                                | Defines and notes                                                                                                                                                                                                                      |
| -------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| libexpat | `config/libexpat/expat_config.h`     | `BYTEORDER 1234`, `XML_DTD 1`, `XML_NS 1`, `XML_GE 1`, `XML_CONTEXT_BYTES 1024`; `HAVE_INTTYPES_H`, `HAVE_STDINT_H`, `HAVE_STDLIB_H`, `HAVE_STRING_H`, `HAVE_SYS_TYPES_H` set to 1. No entropy source is enabled (see Open Decisions). |
| base64   | `config/base64/config.h`             | Every `BASE64_WITH_*` set to 0, so only the generic codec is built.                                                                                                                                                                    |
| tinycbor | `config/tinycbor/tinycbor-export.h`  | `CBOR_API` defined empty, as in the template.                                                                                                                                                                                          |
| tinycbor | `config/tinycbor/tinycbor-version.h` | Version 7.0.0, taken from `project(tinycbor ... VERSION 7.0)` in the pinned `CMakeLists.txt`. The pinned tag is `v7.1`, which does not match that line.                                                                                |
| pcre2    | `config/pcre2/config.h`              | `PCRE2_CODE_UNIT_WIDTH 8`, `SUPPORT_PCRE2_8 1`, then includes the pinned `config.h.generic`. All other options keep the template defaults. JIT and Unicode support stay off.                                                           |
| pcre2    | `config/pcre2/pcre2.h`               | `PCRE2_CODE_UNIT_WIDTH 8`, then includes the pinned `pcre2.h.generic`.                                                                                                                                                                 |

`pcre2` also needs `-DHAVE_CONFIG_H`, because `pcre2_internal.h` includes `config.h` only when that macro is set. The pinned `config.h.generic` documents this requirement.

## Documented Defines

These are the only defines the checks depend on beyond the headers above. Each one is a switch the project documents.

| Define                               | Project | Used in the checks                | Effect                                          |
| ------------------------------------ | ------- | --------------------------------- | ----------------------------------------------- |
| `HAVE_CONFIG_H`                      | pcre2   | yes, for the shim-plus-config run | makes `pcre2_internal.h` read the config header |
| `DR_WAV_NO_STDIO`, `DR_WAV_NO_WCHAR` | dr_libs | variant run only                  | removes the `_w` and stdio functions            |
| `STBI_NO_STDIO`                      | stb     | variant run only                  | removes the stdio image loaders                 |

The default run of dr_libs and stb uses no defines and passes, so the variants are reported for information.

## Open Decisions

- expat stops at its entropy check, which requires `XML_POOR_ENTROPY` or an OS entropy source. `XML_POOR_ENTROPY` disables hash-flood protection. The shim does not set it.
- jq stops at `IEEE_8087`, which its dtoa code requires. jq also includes file and thread headers, and its library loads module files, so the file-API rule applies to it regardless of compilation.
- quickjs-ng needs more libm functions than this shim provides. It stops at `frexp`.

## Limits

- Stubs do not perform I/O. A project whose driver needs files, standard input, threads, or wall-clock time gets a failure at that call.
- The arena holds 4 MiB across all allocations between resets.
- `strtod` rejects decimal inputs outside the fast path. Callers that ignore `errno` receive 0 for those inputs.
- `%f`, `%e` and `%a` are not implemented.
