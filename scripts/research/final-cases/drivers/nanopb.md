# nanopb drivers

Pin: 0.4.92, commit `160d4f09`, Zlib by wording (`LICENSE.txt`, judgement from the W4 sources lane).
Source: `upstream/nanopb/` (`pb_common.c`, `pb_decode.c`, `pb_encode.c`, and `pb.h`, `pb_common.h`,
`pb_encode.h`, `pb_decode.h`, verbatim).

## Candidates

Five candidates, all adapted, in header order: `pb_ostream_from_buffer`, `pb_write`,
`pb_encode_string`, `pb_istream_from_buffer`, `pb_read`.

Not candidates under the rule: `pb_encode_varint` and `pb_decode_varint` (their length is a
`uint64_t` value, not a length), `pb_encode_tag` (`field_number` is not a length), and the field
iterator functions, which take no length.

## Generator

Raw records of 1 to 1000 bytes (`1 + (i * 37) % 1000`), dev default bytes.

## Outputs

Stream drivers write the return flag and `bytes_written` or the decoded value, then the bytes they
produced. `pb_istream_from_buffer` decodes a varint from the record and writes the value and
`bytes_left`. `pb_read` copies the record into the slot and writes `bytes_left`.

## Limits

- No allocation. The arena is not used.
- Integer only, so no libm difference can reach this project.
