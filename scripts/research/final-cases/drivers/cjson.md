# cJSON drivers

Pin: v1.7.19, commit `c859b25d`, MIT (`LICENSE`). Source: `upstream/cjson/` (`cJSON.c` and
`cJSON.h`, verbatim). Only `cJSON.c` is compiled; `cJSON_Utils` is not installed by the project and no
driver uses it.

## Candidates

`corpus-enumerate.ts` reports zero functions for `cJSON.h`, because every prototype is written as
`CJSON_PUBLIC(type) name(...)`. The candidate list was made by applying the rule to those unparsed
prototype lines, and it is recorded in the manifest as a manual list. The main session should fix the
enumerator before the next batch.

Seven candidates, all adapted: `cJSON_ParseWithLength`, `cJSON_ParseWithLengthOpts`,
`cJSON_PrintPreallocated`, `cJSON_CreateIntArray`, `cJSON_CreateFloatArray`,
`cJSON_CreateDoubleArray`, `cJSON_CreateStringArray`.

`cJSON_PrintBuffered(item, int prebuffer, ...)` is not a candidate: `prebuffer` is an `int` that is not
named as a length.

## Generators

- Parse drivers: a JSON document of 4 to 43 items mixing integers below 1000, strings, `true` and
  `null`. No fractions and no exponents, so the shim's `strtod` fast path gives the same value as the
  host libc.
- Int arrays: 8 to 127 values, `(j * 13 + (j >> 7)) & 255) - 128`.
- Float and double arrays: values `k / 4` with `k` from -128 to 127, which are exact in both formats.
- String arrays: 1 to 16 NUL-terminated strings.

## Outputs

Parse and create drivers write the success flag and the length of the printed JSON, then the printed
text. `cJSON_ParseWithLengthOpts` also writes the end offset. `cJSON_PrintPreallocated` writes the
success flag and the length of the text in its buffer.

## Limits

- `cJSON_PrintUnformatted` and `cJSON_PrintPreallocated` format doubles with `%1.15g`. The shim's
  `%g` is exact, and the generators keep values small, so both sides print the same text.
- Printed text longer than `SLOT - 32` writes the length word `0xffffffff` and no text.
