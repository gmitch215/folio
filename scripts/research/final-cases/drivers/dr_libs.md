# dr_libs drivers

Pin: `wav-0.14.6`, commit `35b5c392`. Licence pending: `LICENSE` offers Public Domain (Unlicense) or MIT-0 as alternatives, and `dr_wav.h` says "Choice of public domain or MIT-0." That needs a person to choose, so the manifest entry is `licence: pending`.

## Candidates

The adapters are all from `dr_wav.h`. Rule 1 gives 55 candidates across `dr_wav.h`, `dr_flac.h` and `dr_mp3.h`. The first 12 are adapted. The other 43 are recorded as `over-cap`.

35 more names were rule-1 hits that the enumerator reports as public. They are `drwav__`, `drflac__` and `drmp3__` helpers, declared with `DRWAV_PRIVATE`, `DRFLAC_PRIVATE` or `DRMP3_PRIVATE`, which expand to `static`. They are left out of the candidate list because they are not public API. The enumerator should read those macros, and this is recorded as a defect in the result file.

## Build

The driver file defines `DR_WAV_IMPLEMENTATION` and includes `dr_wav.h` with the shim. The default defines are used. `dr_wav.h` compiles with the shim's `wchar.h` stubs, so no `DR_WAV_NO_STDIO` or `DR_WAV_NO_WCHAR` is needed. The shim's file functions are never called by any adapter.

`-ffp-contract=off` is set for the native build only. Clang fuses multiply-add on arm64 by default and does not on wasm32, so without that flag the float conversions could differ between the two sides. This is a control-arm setting, and the result file says so.

## Generators

- Raw records: `64 + (i * 37) % 704` bytes of the dev byte pattern.
- WAV files (`gen_wav`): a 44-byte PCM header (2 channels, 16 bit, 48 kHz) followed by raw bytes. Used by `drwav_read_raw`.
- Floats (`gen_f32`, `gen_f64`): values `((j * 13 + (j >> 7)) & 255 - 128) / 128` in [-1, 1). They are built from the dev pattern so the converters never see NaN or infinity.

## Adapters

The writer adapters use a memory sink for `onWrite` and `onSeek`. The sink is local to the record, so no writer is kept across records.
