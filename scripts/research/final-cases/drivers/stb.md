# stb drivers

Pin: HEAD `4e9b368b` (the repository has no tags), commit date 2026-11-06. Licence: MIT or Unlicense, from
`LICENSE` (judgement from the W4 sources lane). Source: `upstream/stb/` (`stb_c_lexer.h`, `stb_ds.h`,
`stb_image.h`, verbatim).

## Candidates

Rule 1 gives 33 unique names in enumeration order. The first 12 are adapted, all compiled in the default
configuration (checked with `clang -E`):

`stb_c_lexer_init`, `stbds_hash_bytes`, `stbds_hash_string`, `stbds_arrgrowf`, `stbds_hmfree_func`,
`stbds_hmget_key`, `stbds_hmget_key_ts`, `stbds_hmput_default`, `stbds_hmput_key`, `stbds_hmdel_key`,
`stbi_load_from_memory`, `stbi_load_gif_from_memory`.

The other 21 are over the cap and listed in the manifest with reason `over-cap`.

## Generators

- Lexer: C-like text with identifiers, integers, punctuation, string literals and comments. No real numbers,
  because the shim's `strtod` is a fast path only.
- Hash and hash map drivers: dev default bytes. Keys are record bytes combined with the key index.
- `stbds_hash_string`: NUL-terminated key strings.
- `stbds_arrgrowf`: two 32-bit words per record (the add length and the minimum capacity).
- Image drivers: a PNG and a GIF written inside `prepare()`, outside the timed loop. The PNG uses stored
  deflate blocks and is written in `stb.c`, because `stb_image_write.h` calls `frexp`, which the shim does not
  provide. The GIF has one frame, a 256-grey palette and literal LZW codes with a clear code every 250 pixels.

## Outputs

Scalar results go in the header words. The image drivers write an FNV-1a digest of the decoded pixels and of
the GIF delay array, not the pixels.

## Limits

- `stbds_hash_bytes` and `stbds_hash_string` choose their arithmetic by width. `stb_ds.h` branches on
  `sizeof(size_t) == 8` and rotates `size_t` values, so wasm32 (32-bit `size_t`) and the arm64 host (64-bit)
  compute different hashes. The mismatch is a width difference in the source. It was diagnosed by reading the
  source; no 32-bit native build was run.
- The image drivers decode only the generated PNG and GIF. The JPEG, HDR and 16-bit paths are not exercised.
- `stb_vorbis.c` is not in the header list, so no vorbis candidate was enumerated.
