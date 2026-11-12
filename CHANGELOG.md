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
- `@gmitch215/folio/certify` with `certifyStream`, `verifyCertificate` and `guardInput`. `certifyStream`
  proves that an exported `entry(state, ptr, len)` is the left fold of one affine byte step for every length
  of at least one byte, by running the function symbolically, and returns a certificate bound to the module
  digest or the reason it refused. It covers unrolled loops with tails, tables the module carries or builds
  on its first call, 64-bit states and internal calls over GF(2), Z/2^w and two 16-bit residues of one
  modulus (Adler-32), and a function that rewrites its input in place gets an `output` proof that byte i
  becomes a fixed function of the original byte and the fold state before it.
- `@gmitch215/folio/certified` with `shareCertified`, `installPrefill`, `serveCertified`, `foldCertified`
  and `reconstructCertified`: a certified function runs once per chunk on workers that read the input in
  place from shared memory, and the end states combine through the certificate's model with no second
  pass. `reconstructCertified` runs a kernel that rewrites its input, starting each chunk at the state the
  model gives it.
- `@gmitch215/folio/affine` exports `probeAffine`, `foldAffine` and the affine model types that the
  certificate carries.
- Iteration route options `iterationReadWindows`, `iterationReadSummary`, `iterationSecondChance`,
  `iterationLogCeiling` and `iterationStall`, all off by default. Slot windows, verdict memory and
  cold-start admission were added to the route. A module-local `call_indirect` table no longer refuses a loop.
- `ManagedFolio` options `ranges`, `runs`, `memo` and `inline`, and the paged, hash-verified `Lease`
  (`src/lease.ts`, with `LeaseMismatch`) for immutable content. Managed lanes ship learned byte ranges,
  answer in runs, track inline in a lane and reuse recorded region results.
- `@gmitch215/folio/ownership` with `certifyOwnership` and `verifyOwnership`. `certifyOwnership` proves
  that a record's scratch window is private under six obligations (state isolation, read before write,
  aliasing, final state, escaping addresses, failure) and returns a window and a copy-out rule or a typed
  refusal. Options cover a prefix-written buffer, a configuration premise, recursion and an allocator mode
  with pointer provenance. `verifyOwnership` re-derives a certificate.
- `@gmitch215/folio/ownership-redirect` with `redirectOwnership` and `ownershipRoute`, which run a certified
  window on per-worker shadow copies on the iteration pool, and `@gmitch215/folio/ownership-slices` with
  `OwnershipSlices` and `ownershipSlices`, which run it in place on the slice pool. The slice route is fail
  closed: on a trap or any failure it publishes nothing and reruns serially, and it refuses a certificate
  that has wild stores.
- `@gmitch215/folio/router` with `Router`, `CertificateCache`, `decide` and `analyzeModule`. The router picks
  the certified summary, the certified window, tracked speculation or serial per call, caches certificates
  and refusals by module digest, backend, checker versions and options, and ends a dispatch after two losing
  dispatches. The ownership and router results on the development drivers are development results: 6 of
  10 drivers certify and the router's development interval does not exclude 1.0. On the frozen final
  corpus of 47 drivers the router missed its gates: geomean 0.899 on x86_64 and 0.900 on arm64 against
  1.20, slowest of the five slowest drivers 0.594 and 0.561 against 0.90, no wrong output in 17,484 rows
  (see the report).
- A second verifier for stream certificates (`scripts/research/certify-verify*.ts`), a counts script
  (`certify-counts.ts`) and the four adversary rounds, with their raw rows under `results/certification/`.
- Research tooling for the elastic-memory study under `scripts/research/` and `experiments/elastic*`: the
  translating pass, the translation tax and duration summaries, the stack-limit check pass, the paging
  governor with an injectable clock, a paging runtime with real eviction, and the live ladder harness.
- Research tooling under `scripts/research/` for the corpus, the lane studies and the rig, and
  `export.ts --manifest` so every study sits under the evidence gate. The report carries a Correctness
  Boundary, a Related Work section and the measured limits of each route.

### Changed

- A refused loop in the iteration route is now re-admitted from the median of its serial block means, not the
  lower of the last two, so records of different sizes no longer hide a loop that wins. The first batch after
  a call that stopped on cost is one iteration per worker, and ordered validation is linear in the pairs
  it checks.
- `ContextResetReport` has a new field, `skippedBytes`, always present and zero without `overwrite`.

The evaluation behind this release, including the gates it missed, is in the
[technical report](TECHNICAL_REPORT.md) and under [results/](results).

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
