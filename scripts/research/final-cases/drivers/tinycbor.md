# tinycbor drivers

Pin: v7.1, commit `da6421f2`, MIT (`LICENSE`). Source: `upstream/tinycbor/src/` (the eight library
translation units and their headers, verbatim). The generated headers come from
`config/tinycbor/` (`tinycbor-export.h`, `tinycbor-version.h`); those are not upstream files.

## Candidates

Seven candidates in `cbor.h`, all adapted: `cbor_encoder_init`, `cbor_encode_text_string`,
`cbor_encode_byte_string`, `cbor_encode_raw`, `cbor_encoder_create_array`, `cbor_encoder_create_map`,
`cbor_parser_init`. `cborjson.h` is not installed by the project and has no candidates that take a
length.

The encoder drivers each initialise an encoder over the slot's data area inside the record, so no
encoder is kept across records.

## Generators

- Encoder drivers: raw records of 64 to 1023 bytes, dev default bytes.
- `cbor_parser_init`: a definite-length array of 1 to 12 items, alternating unsigned integers and
  the text `"text"`, encoded by the library in `GEN`.
- `cbor_encoder_create_array` writes `len & 15` unsigned integers from the record. `cbor_encoder_create_map`
  writes `len & 7` key and value pairs.

## Outputs

Encoder drivers write the error code and the encoded length, then the encoded bytes. `cbor_parser_init`
writes the init error, the validation result of the first item and its type.

## Limits

- Arithmetic is integer only, so no libm difference can reach this project.
- The adapters do not use the arena.
