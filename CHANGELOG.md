# Changelog

## 1.1.0

### Added

- `@gmitch215/folio/slices` with `SlicePool` and `SliceConflictError`. `run(entry, count, args)` calls an
  exported function over slices of a range on one shared memory, with one private stack per worker for a
  module that keeps a stack pointer global, no copy and no tracking. The caller declares the calls
  independent; `audit: true` replays the slices serially on a copy of the memory and throws when a returned
  value or a byte below the stacks differs.
- `{ share: true }` for `TaskPool.submit`, `run` and `runSync`, which posts a `SharedArrayBuffer` input
  without copying it. The default still copies.
- `restore(strategy, overwrite)` on `InstanceCheckpoint`: ranges the caller rewrites before the next read are
  neither compared nor copied back, and `ContextResetReport` gains `skippedBytes`. `ContextRange` is exported.
- `@gmitch215/folio/fold` with `chunkRanges`, `foldChunks`, `crc32Combine`, `adler32Combine` and
  `ctrAdvance`, which split a CRC-32, Adler-32 or AES-CTR stream across the task pool and join the chunk
  states into the serial result.
- Iteration route options `iterationReadWindows`, `iterationReadSummary`, `iterationSecondChance`,
  `iterationLogCeiling` and `iterationStall`, all off by default. Slot windows, verdict memory and
  cold-start admission were added to the route. A module-local `call_indirect` table no longer refuses a loop.
- `ManagedFolio` options `ranges`, `runs`, `memo` and `inline`, and the paged, hash-verified `Lease`
  (`src/lease.ts`, with `LeaseMismatch`) for immutable content. Managed lanes ship learned byte ranges,
  answer in runs, track inline in a lane and reuse recorded region results.
- Research tooling under `scripts/research/` for the corpus, the lane studies and the rig, and
  `export.ts --manifest` so every study sits under the evidence gate. The report carries a Correctness
  Boundary, a Related Work section and the measured limits of each route.

### Changed

- A refused loop in the iteration route is now re-admitted from the median of its serial block means, not the
  lower of the last two, so records of different sizes no longer hide a loop that wins. The first batch after
  a call that stopped on cost is one iteration per worker, and ordered validation is linear in the pairs
  it checks.
- `ContextResetReport` has a new field, `skippedBytes`, always present and zero without `overwrite`.

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
