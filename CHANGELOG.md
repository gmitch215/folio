# Changelog

## 1.0.1

### Added

- `@gmitch215/folio/context` with `InstanceCheckpoint` and `ContextResetError`, and `prepareContext`
  in `@gmitch215/folio/compiler`, to reset a private instance between independent jobs.
- `adaptiveRouting` pool option. A call shape that keeps replaying runs natively for 16 calls and is
  then probed again. Off by default.
- `snapshotEncoding: 'auto'` for managed lanes, which omits all-zero pages. Off by default, and
  lanes older than 1.0.1 reject its frames.
- `ImageMismatchError` code `start`.
- Examples for routing, context reset, the task pool and boot images.

### Changed

- The managed snapshot limit defaults to 31 MiB, down from 32 MiB. The frame limit defaults to the
  snapshot limit plus 1 MiB, capped below the 32 MiB Workers RPC argument limit. A frame over the
  limit is not sent, the call runs at the owner, and the fallback diagnostic names the frame size and
  the limit. At 32 MiB every lane call used to fail after the frame was built.
- `bakeModule` refuses a module with a start function.
- `captureImage` compares table slots by function identity, so the table references are copied
  before boot on the same instance.

### Fixed

- `bakeModule` accepted a module whose start function then ran again over the restored heap.
- A `TaskPool` audit compared a changed caller buffer against the submitted copy and raised a false
  `TaskConflictError`. A `SharedArrayBuffer`-backed input is now copied before it is posted.

### Unchanged defaults

Execution routing, `minimumRegionWork` (200,000), the dense snapshot encoding, worker counts and
transaction budgets.

The evaluation behind this release is in the [technical report](TECHNICAL_REPORT.md) and under
[results/](results).
