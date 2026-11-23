# Configuration

This page lists every option a caller sets, grouped by module. Types, defaults and effects come from
the option types in `src/`. An option marked off by default does nothing until the caller sets it.

## Environment

| Setting                                                        | Value           | Effect                                                                                                                     |
| -------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Node                                                           | 26 or later     | The Node backend and the test gate need it. `package.json` declares `engines.node` as `>=26`.                              |
| WebAssembly JSPI                                               | runtime feature | Async host imports (`suspending`, `promising`) and the managed backend need it. The browser counted-loop backend does not. |
| `FREE_CLOUDFLARE_ACCOUNT_ID` and `FREE_CLOUDFLARE_API_TOKEN`   | environment     | `bun run test:e2e` deploys the probes to that account when both are set.                                                   |
| `FOLIO_CLOUDFLARE_ACCOUNT_ID` and `FOLIO_CLOUDFLARE_API_TOKEN` | environment     | The experiments accept these in place of the first pair.                                                                   |
| `FOLIO_OLD_BUILD=1`                                            | environment     | The consumer harness adds an `old-N` arm that runs the archived pre-admission source (see [Core](modules/core.md)).        |
| Package builds                                                 | `snapshot` tag  | Builds from the main branch publish to the `snapshot` tag of `@gmitch215/folio`.                                           |

## Core

### Folio.open

`Folio.open(input, options)` takes these options.

| Option                  | Type                               | Default                                    | Effect                                                                                                                                                                                      |
| ----------------------- | ---------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `memory`                | `WebAssembly.Memory`               | allocated from the module limits           | Binds an existing single imported memory. The iteration route needs it shared, and it grows the memory by the arena it asks for. An unshared or fixed-size memory keeps the program serial. |
| `workers`               | `number`                           | up to 4 (`min(4, availableParallelism())`) | Isolate count. One worker uses the native entry and creates no thread.                                                                                                                      |
| `imports`               | `WebAssembly.Imports`              | none                                       | Host imports, memories, tables and globals as for native instantiation.                                                                                                                     |
| `fuel`                  | `number`                           | 100,000,000                                | Instruction budget per speculative region before it yields to the native head.                                                                                                              |
| `maxTransactionBytes`   | `number`                           | 262,144                                    | Bytes of read and write tracking a lane may retain.                                                                                                                                         |
| `minimumParallelWork`   | `number`                           | 100,000                                    | Estimated iterations below which a proved kernel stays at its original entry.                                                                                                               |
| `promising`             | `readonly string[]`                | none                                       | Exports that return a Promise because they suspend on async host imports.                                                                                                                   |
| `profile`               | `boolean`                          | off                                        | Collects execution timings into `report.profile`.                                                                                                                                           |
| `minimumRegionWork`     | `number`                           | 200,000                                    | Static admission threshold when `open` prepares raw bytes. A prepared plan keeps its own. `0` admits every pure region.                                                                     |
| `assumedTripCount`      | `number`                           | 1,000                                      | Iterations assumed for loops with no constant bound when `open` prepares raw bytes.                                                                                                         |
| `adaptiveRouting`       | `boolean`                          | off                                        | Runs a call shape natively for 16 calls after two runs that mostly replayed or fell back, then probes again. A shape is the entry, width, memory size and numeric arguments.                |
| `iterationLogCeiling`   | `number`                           | off                                        | Undo entries per iteration the logs may grow to when a batch exhausts the default capacity. The batch retries once.                                                                         |
| `iterationReadWindows`  | `boolean`                          | off                                        | Learns read windows from the first conflict-free batch of an iteration loop.                                                                                                                |
| `iterationReadSummary`  | `boolean`                          | off                                        | Keeps a summary of the 64-word blocks of each read bitmap that a read touched.                                                                                                              |
| `iterationStall`        | `boolean` or `{ factor, floorMs }` | off                                        | Stops an iteration batch that does not return and finishes the loop serially. `factor` defaults to 50 and `floorMs` to 2000.                                                                |
| `iterationSecondChance` | `boolean`                          | off                                        | Judges a loop a little under the dispatch floor on one timed batch.                                                                                                                         |

### Prepare and Run

| Option              | Where                            | Type                               | Default    | Effect                                                    |
| ------------------- | -------------------------------- | ---------------------------------- | ---------- | --------------------------------------------------------- |
| `parallel`          | `prepare(bytes, options)`        | `'auto'` or `'off'`                | `'auto'`   | `'off'` keeps the original module with no plan.           |
| `minimumRegionWork` | `prepare(bytes, options)`        | `number`                           | 200,000    | Static admission threshold in instruction units.          |
| `assumedTripCount`  | `prepare(bytes, options)`        | `number`                           | 1,000      | Iterations assumed for loops with no constant bound.      |
| `parallel`          | `folio.run(name, args, options)` | `'auto'`, `'off'` or `'speculate'` | `'auto'`   | Automatic routing, original execution or tracked regions. |
| `maximumWorkers`    | `folio.run(name, args, options)` | `number`                           | pool width | Caps participating workers without recreating the group.  |

### Execution Host

`new FolioHost(options)` takes `artifacts`, `authorize`, `limits` and `path`.

| Option                       | Type                                                | Default  | Effect                                                                                                                                            |
| ---------------------------- | --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts`                  | `Record<string, HostArtifact>`                      | required | Trusted programs by artifact id. Each has a `program`, an `exports` allowlist and an optional `create` that returns pool options and a `dispose`. |
| `authorize`                  | `(request: Request) => boolean or Promise<boolean>` | required | Decides whether a request may proceed.                                                                                                            |
| `path`                       | `string`                                            | `/folio` | Path the handler serves.                                                                                                                          |
| `limits.liveGroups`          | `number`                                            | 4        | Groups open at once. Further opens are refused.                                                                                                   |
| `limits.workersPerGroup`     | `number`                                            | 8        | Workers a single session may request.                                                                                                             |
| `limits.memoryBytesPerGroup` | `number`                                            | 64 MiB   | Initial accessible canonical backing admitted per group. Trusted bindings enforce growth maxima.                                                  |
| `limits.requestBytes`        | `number`                                            | 2 MiB    | Largest request body.                                                                                                                             |
| `limits.responseBytes`       | `number`                                            | 2 MiB    | Largest response body. It must leave at least 512 bytes for errors.                                                                               |
| `limits.readBytes`           | `number`                                            | 512 KiB  | Largest single memory read.                                                                                                                       |
| `limits.writeBytes`          | `number`                                            | 512 KiB  | Largest single memory write.                                                                                                                      |
| `limits.argumentsPerCall`    | `number`                                            | 64       | Most arguments in one call.                                                                                                                       |
| `limits.idleMilliseconds`    | `number`                                            | 300,000  | Idle time before a session expires. Active operations postpone expiry.                                                                            |
| `limits.retainedSessions`    | `number`                                            | 64       | Sessions whose last response the host keeps for `retryPending()`.                                                                                 |

Every limit is a positive safe integer.

### Instance Checkpoints

| Call                           | Option      | Type                            | Default     | Effect                                                                                                              |
| ------------------------------ | ----------- | ------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------- |
| `restore(strategy, overwrite)` | `strategy`  | `'changed'` or `'full'`         | `'changed'` | `'changed'` compares each 64 KiB page and rewrites the pages that differ. `'full'` copies every byte.               |
| `restore(strategy, overwrite)` | `overwrite` | `{ memory?, offset, length }[]` | none        | Ranges that are neither compared nor copied back. The caller writes every byte of them before the program reads it. |

## Pools

### TaskPool

`new TaskPool(count or links, options)` takes a worker count or the owner ends of existing links.

| Option        | Type                                                | Default | Effect                                                                                                              |
| ------------- | --------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `audit.run`   | `(name, input) => TaskInput`                        | none    | Reruns a task in the joining thread. A differing output throws `TaskConflictError`.                                 |
| `audit.every` | `number`                                            | 1       | Reruns every nth task.                                                                                              |
| `pool.width`  | `number` (property)                                 | `size`  | How many workers take tasks, from 1 to `size`.                                                                      |
| `share`       | `boolean` (option of `submit`, `run` and `runSync`) | `false` | Posts a `SharedArrayBuffer`-backed input without copying it. The caller does not write it until the task is joined. |

`serveTasks(link, run, options)` takes `cpu`, a function that reads the thread's CPU time in
milliseconds and defaults to `process.threadCpuUsage`.

### SlicePool

`SlicePool.open(bytes, options)` takes these options.

| Option       | Type                 | Default                          | Effect                                                                                                  |
| ------------ | -------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `memory`     | `WebAssembly.Memory` | required                         | The shared memory every worker runs on. It needs a declared maximum with room for one stack per worker. |
| `workers`    | `number`             | `min(availableParallelism(), 8)` | Worker count.                                                                                           |
| `stackBytes` | `number`             | 65,536                           | Private stack per worker, a multiple of 65,536. Only modules with a stack pointer global get stacks.    |
| `imports`    | `string` or `URL`    | none                             | A module whose default export returns the imports besides the memory. Each worker loads it.             |
| `ownership`  | `OwnershipPlan`      | none                             | The plan of a module that `redirectOwnership` rewrote. `ownershipSlices` sets it.                       |

`pool.run(entry, count, args, options)` takes these options.

| Option          | Type                 | Default                     | Effect                                                                                      |
| --------------- | -------------------- | --------------------------- | ------------------------------------------------------------------------------------------- |
| `grain`         | `number`             | even split over the workers | Calls per slice.                                                                            |
| `audit`         | `boolean`            | `false`                     | Replays the slices serially on a copy and throws `SliceConflictError` on a difference.      |
| `writes`        | `[number, number][]` | none                        | Byte ranges the calls write outside the windows. A pool opened with `ownership` needs them. |
| `snapshotLimit` | `number`             | 64 MiB                      | Largest copy of `writes` in bytes. Past it the calls run serially in place.                 |

## Folds and Certificates

| Call                                                       | Option       | Type                                           | Default                                 | Effect                                                                                                      |
| ---------------------------------------------------------- | ------------ | ---------------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `foldChunks(pool, input, options)`                         | `align`      | `number`                                       | 1                                       | Every chunk but the last starts and ends on a multiple of this.                                             |
| `foldChunks(pool, input, options)`                         | `chunks`     | `{ start, end }[]`                             | `pool.width` aligned chunks             | Explicit chunk ranges.                                                                                      |
| `foldChunks(pool, input, options)`                         | `task`       | `(chunk) => string`                            | required                                | Name of the task that runs one chunk.                                                                       |
| `foldChunks(pool, input, options)`                         | `initial`    | `State`                                        | required                                | State before the first chunk.                                                                               |
| `foldChunks(pool, input, options)`                         | `combine`    | `(state, part, chunk) => State`                | required                                | Folds one chunk's joined result into the state, in order.                                                   |
| `certifyStream(bytes, entry, options)`                     | `layout`     | `{ state, ptr, len }`                          | 0, 1, 2                                 | Parameter positions of the state, the pointer and the length.                                               |
| `certifyStream(bytes, entry, options)`                     | `block`      | `number`                                       | 4, then 16                              | Lengths below this run concretely, the rest as quotient and remainder.                                      |
| `certifyStream(bytes, entry, options)`                     | `maxMs`      | `number`                                       | 30,000                                  | Wall clock limit of the whole call across the block ladder.                                                 |
| `certifyStream(bytes, entry, options)`                     | `ring`       | `'gf2'`, `'z2w'` or `'zp'`                     | tries `gf2`, `z2w`, `zp`                | Restricts the analysis to one ring.                                                                         |
| `foldCertified(pool, input, memory, certificate, options)` | `initial`    | `bigint`                                       | 0                                       | State before the first byte.                                                                                |
| `foldCertified(pool, input, memory, certificate, options)` | `chunks`     | `{ start, end }[]`                             | `pool.width` chunks                     | Explicit chunk ranges.                                                                                      |
| `certifyOwnership(bytes, options)`                         | `entry`      | `string`                                       | `bulk`                                  | Exported function that runs the records loop.                                                               |
| `certifyOwnership(bytes, options)`                         | `convention` | `{ table, count, out, pointers, recordBytes }` | 0, 1, 2; pointers at 0, 8, 12; 16 bytes | Parameter positions and the record layout.                                                                  |
| `certifyOwnership(bytes, options)`                         | `proposed`   | `{ low, end }[]`                               | none                                    | Windows proposed by a probe. They only add bytes to the windows the checker derives.                        |
| `certifyOwnership(bytes, options)`                         | `maxSteps`   | `number`                                       | 4,000,000                               | Step limit of one analysis pass.                                                                            |
| `certifyOwnership(bytes, options)`                         | `allocator`  | `{ arenaBytes, arenaWord?, assumeInArena? }`   | off                                     | The allocator mode, where the record's arena pointer may be stored in a window and used to allocate.        |
| `certifyOwnership(bytes, options)`                         | `prefix`     | `true` or `{ cell, base }`                     | off                                     | The prefix-written domain: a buffer filled up to a cursor cell.                                             |
| `certifyOwnership(bytes, options)`                         | `config`     | `{ word, at, bytes, extent }`                  | off                                     | A configuration every record shares and none writes.                                                        |
| `certifyOwnership(bytes, options)`                         | `recursion`  | `number`                                       | off                                     | The deepest nesting of one function in the call stack the checker follows. Without it recursion is refused. |

`ownershipSlices(bytes, certificate, options)` takes the `SlicePool` options except `ownership`. Its
`run(count, args, options)` takes the slice run options with `regions` added, the regions every
record touches, and `writes` made required.

### Router

`Router.open(bytes, call, options)` takes these options.

| Option      | Type                                            | Default                          | Effect                                                                                                                                  |
| ----------- | ----------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `mode`      | `RouterMode`                                    | required                         | `router`, `serial`, `w1`, `w2`, `independent` or `shared`.                                                                              |
| `pages`     | `number`                                        | required                         | Initial pages of the memory the router allocates.                                                                                       |
| `maxPages`  | `number`                                        | the module's own limit           | Declared maximum of the shared memory a records call runs on.                                                                           |
| `workers`   | `number`                                        | `min(availableParallelism(), 8)` | Worker count.                                                                                                                           |
| `cache`     | `CertificateCache`                              | new cache                        | Holds certificates and refusals between calls.                                                                                          |
| `imports`   | `string` or `URL`                               | none                             | A module whose default export returns the imports besides the memory.                                                                   |
| `assume`    | `{ importsDeterministic?, residueUnobserved? }` | none                             | What the caller knows that no static test can establish. Tracked speculation needs it.                                                  |
| `explicit`  | `(call) => Promise<void>`                       | none                             | Runs the records on a route the caller built. Chosen after the window route in `router` mode.                                           |
| `floors`    | `Partial<RouterConstants>`                      | `routerConstants`                | Overrides for the window floor (0.8 ms), the tracked floor and the summary minimum (1 MiB). A sweep sets them to 0 to force a dispatch. |
| `ownership` | `OwnershipOptions`                              | none                             | Certifier options that change a certificate, and so the cache key.                                                                      |

## Workers

`new ManagedFolio(artifact, options)` takes these options.

| Option                 | Type                            | Default                                               | Effect                                                                                                           |
| ---------------------- | ------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `lanes`                | `ManagedLaneTransport[]`        | required                                              | From 1 to 64 transports. Each sends a binary frame to a `FolioLane`.                                             |
| `imports`              | `WebAssembly.Imports`           | none                                                  | Host imports. Bind several memories by name here.                                                                |
| `memory`               | `WebAssembly.Memory`            | none                                                  | Binds a single imported memory.                                                                                  |
| `fuel`                 | `number`                        | 100,000,000                                           | Speculative back-edges per call, from 1 to 1,000,000,000. A call that runs out finishes serially at the owner.   |
| `maxTransactionBytes`  | `number`                        | 262,144                                               | Tracking budget, from 8 bytes to 1 MiB.                                                                          |
| `maximumSnapshotBytes` | `number`                        | 31 MiB                                                | Largest arena a run may snapshot.                                                                                |
| `maximumFrameBytes`    | `number`                        | snapshot limit plus 1 MiB, below the 32 MiB RPC limit | Largest request frame a transport accepts. A larger frame is not sent and the call runs at the owner.            |
| `promising`            | `readonly string[]`             | none                                                  | Exports that return a Promise because they suspend on async host imports.                                        |
| `snapshotEncoding`     | `'auto'` or `'dense'`           | `'dense'`                                             | `'dense'` sends the whole snapshot. `'auto'` omits zero pages, which lanes older than 1.0.1 reject.              |
| `ranges`               | `{ maxRounds?, cacheEntries? }` | off                                                   | Ships learned byte ranges instead of a snapshot. `maxRounds` defaults to 3 (1 to 8) and `cacheEntries` to 1,024. |
| `runs`                 | `boolean`                       | off                                                   | Asks lanes to answer in sorted byte runs that the owner validates and commits as intervals.                      |
| `memo`                 | `{ bytes?, entries? }`          | off                                                   | Reuses recorded results of regions whose read bytes are unchanged, through the same ordered validation.          |

`new FolioLane(module, options)` takes `initial` and `maximum` (pages), and optionally
`maximumMemoryBytes`, `maximumFrameBytes`, `dataSegments` (the start and length of each active data
segment) and `inline` (`{ module, logEntries }`, where `logEntries` defaults to 8,192 write granules
of 32 bytes). `inline` is off unless set.

`RemoteFolio.open(url, artifact, options)` takes `fetch` (a service binding's fetch or an ordinary
one), `headers` (sent with every request, usually `authorization`), `maximumResponseBytes` (2 MiB by
default) and `workers`.

## Browser

`BrowserFolio.open` takes these options.

| Option                | Type                           | Default            | Effect                                                                         |
| --------------------- | ------------------------------ | ------------------ | ------------------------------------------------------------------------------ |
| `memory`              | `WebAssembly.Memory`           | none               | The shared memory the workers attach to. The caller keeps exclusive ownership. |
| `imports`             | `WebAssembly.Imports`          | none               | Host imports.                                                                  |
| `workers`             | `number`                       | 4                  | Worker count, an integer from 1 to 32.                                         |
| `workerURL`           | `string` or `URL`              | the package worker | Entry of the dedicated module workers.                                         |
| `workerFactory`       | `(index) => BrowserWorkerPort` | none               | Creates each worker port in place of `workerURL`.                              |
| `minimumParallelWork` | `number`                       | 100,000            | Estimated iterations below which a call runs at the owner.                     |

## Memory

| Call                                    | Option                 | Type                                      | Default    | Effect                                                                              |
| --------------------------------------- | ---------------------- | ----------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `governGrowth(memory, options)`         | `capBytes`             | `number`                                  | required   | Refuses any `memory.grow` whose final size would pass this. A positive integer.     |
| `governGrowth(memory, options)`         | `onRefuse`             | `({ fromBytes, toBytes }) => void`        | none       | Called for each refused grow.                                                       |
| `new PageDirectory(options)`            | `scope`                | `PageScope`                               | required   | Fresh incarnation for one trusted active directory. Never reuse it after a restart. |
| `new PageDirectory(options)`            | `owners`               | `readonly PageOwner[]`                    | required   | Page owners.                                                                        |
| `new PageDirectory(options)`            | `initialPages`         | `number`                                  | 0          | Pages in the fresh zero-filled arena.                                               |
| `new PageDirectory(options)`            | `maximumPages`         | `number`                                  | 65,536     | Most pages, up to 65,536.                                                           |
| `new PageDirectory(options)`            | `maximumLeases`        | `number`                                  | 64         | Most live leases.                                                                   |
| `new PageDirectory(options)`            | `maximumLeasePages`    | `number`                                  | 256        | Most pages one lease holds.                                                         |
| `new PageDirectory(options)`            | `maximumResidentPages` | `number`                                  | 512        | Most resident pages.                                                                |
| `new PageDirectory(options)`            | `maximumRetiredPages`  | `number`                                  | 1,024      | Most retired versions kept before `collect()`.                                      |
| `new PageDirectory(options)`            | `leaseMilliseconds`    | `number`                                  | 30,000     | Lease lifetime.                                                                     |
| `new PageDirectory(options)`            | `clock`                | `() => number`                            | `Date.now` | Time source.                                                                        |
| `new MemoryPageOwner(id, scope, bytes)` | `maximumBytes`         | `number`                                  | required   | Credit in bytes, at least one page.                                                 |
| `new Lease(options)`                    | `manifest`             | `LeaseManifest`                           | required   | The page hashes of the remote immutable object.                                     |
| `new Lease(options)`                    | `fetchRange`           | `(offset, length) => Promise<Uint8Array>` | required   | The remote read.                                                                    |
| `new Lease(options)`                    | `residentBytes`        | `number`                                  | 4 MiB      | LRU budget in bytes, raised to one page when smaller.                               |
| `new Lease(options)`                    | `retries`              | `number`                                  | 1          | Refetches of a page whose bytes failed verification.                                |
| elastic regions                         | `byteLength`           | `number`                                  | required   | Logical size in bytes, a whole number of chunks.                                    |
| elastic regions                         | `chunkBytes`           | `number`                                  | required   | A power of two from 4 KiB to 8 MiB.                                                 |
| elastic regions                         | `frames`               | `number`                                  | required   | Resident window in chunks, at least 1.                                              |

## Boot

| Call                                 | Option              | Type                                | Default | Effect                                                                                           |
| ------------------------------------ | ------------------- | ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `captureImage(...)`                  | `module`            | `string`                            | none    | SHA-256 hex of the module bytes. `moduleDigest(bytes)` computes it.                              |
| `captureImage(...)`                  | `context`           | `string`                            | none    | A digest of whatever else shapes the heap (settings, shims, assets).                             |
| `captureImage(...)`                  | `globals`           | `{ booted, fresh }` by global index | none    | Global values read from the booted and the fresh instance.                                       |
| `captureImage(...)`                  | `table`             | `{ booted, fresh }` tables          | none    | The table after boot and a table holding the pre-boot function references.                       |
| `bakeModule(bytes, image, options)`  | `maxSegmentBytes`   | `number`                            | 64 MiB  | Largest data segment, a multiple of 65,536.                                                      |
| `bakeModule(bytes, image, options)`  | `allowTableChanges` | `boolean`                           | `false` | Bakes an image that reports changed table slots. The caller restores them.                       |
| `applyImage(memory, image, options)` | `module`            | `string`                            | none    | Refuses an image whose module digest differs, or that carries none.                              |
| `applyImage(memory, image, options)` | `context`           | `string`                            | none    | Refuses an image whose context digest differs, or that carries none.                             |
| `applyImage(memory, image, options)` | `memoryOnly`        | `boolean`                           | `false` | Copies the pages of an image that records changed globals or table slots and leaves those fresh. |

## Continuation

| Call                                     | Option               | Type                                 | Default         | Effect                                                                                   |
| ---------------------------------------- | -------------------- | ------------------------------------ | --------------- | ---------------------------------------------------------------------------------------- |
| `runSlice(options)`                      | `storage`            | `DurableObjectStorage`               | required        | The object's storage.                                                                    |
| `runSlice(options)`                      | `memory`             | `WebAssembly.Memory`                 | required        | The guest's memory.                                                                      |
| `runSlice(options)`                      | `run`                | `(budgetSteps) => StopReason`        | required        | Runs up to the budget and returns `finished`, `signal` or `budget` at a quiescent point. |
| `runSlice(options)`                      | `steps`              | `() => number`                       | required        | The guest's monotonic step counter.                                                      |
| `runSlice(options)`                      | `signal`             | `CpuSignal`                          | none            | From `cpuSignal()`. Cleared at the start of each slice.                                  |
| `runSlice(options)`                      | `globals`            | `Record<string, WebAssembly.Global>` | none            | Mutable globals saved with each checkpoint.                                              |
| `runSlice(options)`                      | `initialBudget`      | `number`                             | 2,000           | Step budget of the first slice.                                                          |
| `runSlice(options)`                      | `state`              | `() => string or undefined`          | none            | Host state saved with each checkpoint.                                                   |
| `runSlice(options)`                      | `restore`            | `(state) => void`                    | none            | Called after a restore and before `run`.                                                 |
| `saveCheckpoint(store, memory, options)` | `globals`            | `Record<string, WebAssembly.Global>` | none            | Mutable globals saved with the pages.                                                    |
| `saveCheckpoint(store, memory, options)` | `state`, `stateJson` | `string`, `unknown`                  | none            | Host state record. Pass one of them, not both.                                           |
| `sqlCheckpointStore(sql, options)`       | `prefix`             | `string`                             | `continuation_` | Table name prefix.                                                                       |
| `sqlCheckpointStore(sql, options)`       | `groupPages`         | `number`                             | 16              | Pages per row, 1 MiB at the default.                                                     |
| `sqlCheckpointStore(sql, options)`       | `sync`               | `() => Promise<void>`                | none            | Becomes the store's `flush`. Pass `() => storage.sync()` inside a Durable Object.        |

## See Also

- [Getting Started](getting-started.md) for the first run, and [Limits](limits.md) for what each
  setting cannot change.
- The module pages explain each option in context: [Core](modules/core.md),
  [Pools](modules/pools.md), [Folds and Certificates](modules/folds-and-certificates.md),
  [Workers](modules/workers.md), [Browser](modules/browser.md), [Memory](modules/memory.md),
  [Boot](modules/boot.md) and [Continuation](modules/continuation.md).
