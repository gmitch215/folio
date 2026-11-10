# base64 drivers

Pin: v0.5.3, commit `5d5074cb`, BSD-2-Clause (`LICENSE`). Source: `upstream/base64/` (`include/`,
the four library translation units, the headers and the 32-bit and 64-bit generic loops, verbatim).
`config/base64/config.h` turns every SIMD codec off, so only the generic codec is built.

## Candidates

Four candidates in `libbase64.h`, all adapted: `base64_encode`, `base64_stream_encode`,
`base64_decode`, `base64_stream_decode`. The two `*_init` and `base64_stream_encode_final` functions
take no length, so they are not candidates.

The stream drivers initialise the state inside the record. Nothing is kept across records.

## Stubs

`codec_choose.c` names the SIMD codecs in its forced-flag branches, so a link needs their symbols.
`drivers/base64.c` defines them as stubs that trap. Every adapter passes flags 0, so no stub runs.

## Generators

- Encode drivers: raw records of 1 to 1000 bytes, dev default bytes.
- Decode drivers: the record is base64 text of a raw record of 1 to 768 bytes, encoded by the
  library in `GEN` during `prepare()`.

## Limits

- The 64-bit generic encode loop is vendored from the pin because the arm64 host selects it.
  The decode loop is the 32-bit file on both targets.
- Integer only, so no libm difference can reach this project.
