# zopfli drivers

Pin: `zopfli-1.0.3`, commit `bd64b2f0`, Apache-2.0 (`COPYING`). Source: `upstream/zopfli/src/zopfli/`
(the twelve library translation units and their headers; `zopfli_bin.c` is not vendored).

## Candidates

One candidate: `ZopfliCompress`. `ZopfliInitOptions` takes no length, so it is not a candidate.

The tree has no install rule for `zopfli.h`. Its only API header is `src/zopfli/zopfli.h`, which
`zopflipng` includes, so the rule's header clause is read as that header. This reading was made before
any build.

## Generator

Raw records of 64 to 767 bytes (`64 + (i * 37) % 704`), dev default bytes. Output is the compressed
stream with default options (`ZopfliInitOptions`).

## Adapter

The adapter reads `size` and copies the output when it fits in the slot. It frees the buffer that
zopfli returned.

## Limits

- The driver does not run. `ZopfliCompress` allocates per iteration and the shim `free` does nothing.
  A counting shim with a 512 MiB arena measured a peak of 152744208 bytes in one record, so the
  `ARENA` rule gives 512 MiB, and 64 slices of that need 34360079424 bytes, over the wasm32 limit.
  With a smaller arena `malloc` returns `NULL`, and `ZopfliResetHash` writes through it and traps
  with an out-of-bounds access (the earlier trap, now explained). The manifest records the layout
  error.
