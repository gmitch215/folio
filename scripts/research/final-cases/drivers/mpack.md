# mpack drivers

Pin: `v1.1.1`, commit `79d3fcd3`. Licence: MIT, `LICENSE`. Source: `upstream/mpack/src/mpack/` (the seven
public headers and six translation units, verbatim).

## Candidates

Rule 1 gives 102 unique names. The window is the first 12 names in enumeration order that have a definition in
the default build (rule 1b). Twelve names before the window's end are not linkable and are listed with reason
`compiled-out`: ten guarded by `MPACK_DEBUG && MPACK_STDIO` or `MPACK_INTERNAL` (both 0 with `-DNDEBUG`), plus
`mpack_write_ext` and `mpack_start_ext`, which are not declared in the default configuration. The check is
`scratchpad/v11/w4/batchD/linkable.mjs`.

The window is:

- `mpack_writer_track_push` and `mpack_writer_track_bytes`. Their non-tracking definitions in `mpack-writer.h`
  have a body that only calls `MPACK_UNUSED`, so these two adapters call a no-op. They are legitimate candidates
  under rule 1b and their checksums are constant by construction. Their timings measure call overhead.
- `mpack_writer_init`, `mpack_write_object_bytes`, `mpack_start_array`, `mpack_start_map`, `mpack_write_str`,
  `mpack_write_utf8`, `mpack_write_bin`, `mpack_start_str`, `mpack_start_bin`, `mpack_write_bytes`. Each runs on a
  writer created inside the record, so no state is kept across records.

Every other name is listed with reason `over-cap`. The reader and node API follow the window.

## Generator

Eight raw bytes per record. Byte 0 selects the type (`str`, `bin`, `array`, `map`), bytes 4 to 7 give the count.
The data adapters take their bytes from the record itself with length `byte 4 & 7`, so a length is at most 7.

## Outputs

The writer error and the buffer use, as two words. The ten writer-core adapters also copy the first 32 bytes of the
writer's buffer into the slot's data area. The two tracking adapters do not.

## Limits

- The window is not a sample of mpack. Read the result as "the first 12 by enumeration order, two of which
  are real calls and both are no-ops in the default build."
- Tracking and debug builds would change the candidate set. They are off here because the default build is the
  stated configuration.
