# minimp3 drivers

Pin: HEAD `ea99364f` (no tags). Licence: CC0-1.0, `LICENSE`. Source: `upstream/minimp3/minimp3.h`, verbatim.

## Candidates

Rule 1 gives 0. `mp3_bytes` and `num_samples` are integers after a pointer but are not named `len`, `size`,
`count` or `length`, so the narrow reading excludes them. Rule 2 applies: the header has no unparsed public
declaration, and its three non-static API functions take non-const pointers.

- `mp3dec_init`: adapted, builds and matches native.
- `mp3dec_f32_to_s16`: its declaration sits under `#ifdef MINIMP3_FLOAT_OUTPUT`. The default build does not
  declare it, so under rule 1b it is `compiled-out` and outside the window. The window is the two linkable
  candidates, `mp3dec_init` and `mp3dec_decode_frame`. The driver entry stays in the manifest as `build: failed`
  (the manifest keeps failed builds). Enabling the float output for this kernel would change its stated
  configuration, so it was not done.
- `mp3dec_decode_frame`: adapted, builds and matches native.

## Native flag

On arm64, `minimp3.h` defines `MINIMP3_ONLY_SIMD` and takes the NEON path. The wasm build has no SIMD path.
The first native build without a flag differed from the Wasm slots on every frame that decoded. Adding
`-DMINIMP3_NO_SIMD` to the native build alone makes the two paths match. `-ffp-contract=off` was not added:
the match held without it.

## Generators

- `mp3dec_init`: 16 record bytes fill the decoder state first, so the init has to clear them.
- `mp3dec_f32_to_s16`: 16 to 1023 samples of multiples of 1/1024 in [-1.5, 1.5), which exercises the clamp.
- `mp3dec_decode_frame`: one MPEG-1 Layer III frame, 128 kbps, 44.1 kHz, stereo, 417 bytes. The side info is
  valid: `main_data_begin` 0, and each granule and channel codes 64 bits of main data with one Huffman pair in
  table 1. The main data after the side info is pseudo-random. With random side info every frame was rejected
  and the decode driver checked nothing (64 of 64 returned 0 samples).

## Outputs

`mp3dec_decode_frame` returns samples per channel in word 0, the six `frame_info` fields in words 1 to 5, and
the PCM in the data area.

## Limits

- The decode input is structured, not a real encoded stream. Decoded sample counts are recorded per slot in the
  driver's word 0 (1152 for every record in the run).
