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
- Examples for routing, context reset, the task pool, boot images and the iteration route.
- An iteration route for `Folio.run`: a function with one countdown loop whose iterations call into a
  function set that may use one stack-pointer global and recursion runs its iterations on workers, on
  private stack slots, with ordered validation and serial replay. It needs a shared `memory` option. The
  first iteration runs on the owner and its measured time, and then the time of each batch, decide whether
  dispatch continues. Pointer and counter updates may sit anywhere at the top level of the loop body, with a
  constant step or a step held in a local that the loop does not write. `ExecutionReport` gains
  `extraction: 'iteration'` and an `iteration` field, and `reason` gains `no-arena`,
  `memory-size-observed`, `import-order`, `workers-unavailable`, `trip-zero`, `no-admission`,
  `log-exhausted` and `frame-carried dependence`. Dispatch ends, and the rest of the loop runs serially,
  when an iteration exhausts its undo log (2,048 write granules), a frame conflict occurs, a batch
  replays more than half of its iterations, or the batches lose to the serial time.

### Changed

- The managed snapshot limit defaults to 31 MiB, down from 32 MiB. The frame limit defaults to the
  snapshot limit plus 1 MiB, capped below the 32 MiB Workers RPC argument limit. A frame over the
  limit is not sent, the call runs at the owner, and the fallback diagnostic names the frame size and
  the limit. At 32 MiB every lane call used to fail after the frame was built.
- A program with no plan, an eligible loop and a shared host `memory` dispatches under
  `parallel: 'auto'`. `parallel: 'off'` and a host memory that is not shared keep the serial run.
- `captureImage` compares table slots by function identity, so the table references are copied
  before boot on the same instance.

### Fixed

- `bakeModule` accepted a module whose start function then ran again over the restored heap.
- A `TaskPool` audit compared a changed caller buffer against the submitted copy and raised a false
  `TaskConflictError`. A `SharedArrayBuffer`-backed input is now copied before it is posted.

### Unchanged defaults

`minimumRegionWork` (200,000), the dense snapshot encoding, worker counts and transaction budgets.
A program that already had a plan keeps it.

The evaluation behind this release is in the [technical report](TECHNICAL_REPORT.md) and under
[results/](results).
