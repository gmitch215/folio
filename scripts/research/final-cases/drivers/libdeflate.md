# libdeflate drivers

Pin: v1.26, commit `92e6a0db`, MIT (`COPYING`). Source: `upstream/libdeflate/` (the nine translation
units and the headers they include, copied verbatim from the pin).

## Candidates

`libdeflate.h` declares 14 candidates in this order: `deflate_compress`, `deflate_compress_bound`,
`zlib_compress`, `zlib_compress_bound`, `gzip_compress`, `gzip_compress_bound`,
`deflate_decompress`, `deflate_decompress_ex`, `zlib_decompress`, `zlib_decompress_ex`,
`gzip_decompress`, `gzip_decompress_ex`, `adler32`, `crc32`.

The first 12 are adapted. `adler32` and `crc32` are skipped with reason `over-cap`.

## Generators

- Compress and bound drivers: raw records of 64 to 1023 bytes (`64 + (i * 37) % 960`), dev default
  bytes.
- Decompress drivers: the record is a stream made by the library's own compressor at level 6, in the
  format of the driver (deflate, zlib or gzip). The stream is built once in `prepare()`.

## Adapters

Each compress or decompress call allocates its compressor or decompressor per record and frees it
before the record ends. Nothing is kept across records, so no driver needs context init. Each record
allocates from its own arena slice, set at the start of `one()`.

Outputs: compress drivers write the return value and the compressed bytes. Decompress drivers write
the result code and the produced length (and both input and output lengths for the `_ex` forms), then
the decompressed bytes.

## Limits

- The native build passes `-U__aarch64__`. The vendored tree has no `arm/` sources, so libdeflate's
  arch selection would otherwise include files that are not there. With the macro undefined, the
  native build uses the generic code path, which is the path the Wasm build takes.
- Each record has its own arena slice and `free` does nothing. Compress drivers peak at 668320
  bytes per record, so their `ARENA` is 2 MiB.
