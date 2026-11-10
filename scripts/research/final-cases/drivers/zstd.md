# zstd drivers

Pin: `v1.5.7`, commit `f8745da6`. Licence pending: `LICENSE` (BSD) and `COPYING` (GPL-2.0) are both present, and `lib/zstd.h` lets the user pick either. That is a choice for a person, so the manifest entry is `licence: pending`.

## Candidates

Rule 1 gives 85 unique names from `lib/zstd.h`, `lib/zdict.h` and `lib/zstd_errors.h`, in enumeration order. The first 12 are adapted. The other 73 are recorded as `over-cap`.

## Configuration

`ZSTD_LEGACY_SUPPORT=0` is set on both sides. It is the project's own switch, and it keeps the legacy decoders (`lib/legacy/`) out of the closure. Multithreading stays off, which is the default.

## Generators

- Raw records: `64 + (i * 37) % 704` bytes of the dev byte pattern. Used by the compress-side drivers.
- Frames (`gen_frame`): the raw record compressed with `ZSTD_compress` at level 3. Used by the decode and frame-inspection drivers. The encoder runs in `prepare()`, outside the timed loop.
- Dictionary frames (`gen_frame_dict`): compressed with `ZSTD_compress_usingDict`, using the 128-byte dictionary `dict[j] = j * 29 + 7`.

## Adapters

Every adapter that allocates calls `bump_set(P(r->arena), ARENA)` first, because zstd allocates per call and the shim `free` does nothing. Create and free happen inside the record, so no context is kept across records.
