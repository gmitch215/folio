# 🚋 Folio

> ⚡ Shared WebAssembly memory and ordered speculative execution across isolates

Folio runs native WebAssembly across several V8 isolates that share one physical memory allocation.
It finds inline memory regions and pure calls in ordinary programs, validates the ones it cannot
prove independent, and keeps the serial result. Scalar results, control flow and opaque state stay
in the original Wasm instance. A portable client connects workerd and managed Cloudflare Workers to
the same engine.

## Table of Contents

- [Why Folio](#-why-folio)
- [Features](#-features)
- [Install](#-install)
- [Getting Started](#-getting-started)
- [Asynchronous Host Effects](#-asynchronous-host-effects)
- [Execution Host](#-execution-host)
- [Managed Workers](#-managed-workers)
- [Browser Execution and Page Leases](#-browser-execution-and-page-leases)
- [Task Pool](#-task-pool)
- [Baked Boot Images](#-baked-boot-images)
- [Execution and Memory](#-execution-and-memory)
- [API Reference](#-api-reference)
- [Consumer Harness](#-consumer-harness)
- [Measured Results](#-measured-results)
- [Development](#-development)
- [Contributing](#-contributing)
- [License](#-license)

## 🧭 Why Folio

A Worker, a Linux machine in a Durable Object and a PHP interpreter all end up as one Wasm
instance on one thread. Folio spreads the work of that instance across cores without asking the
program to be rewritten. The caller passes one ordinary entry point. The compiler discovers the
regions, so there are no access annotations and no caller-created chunks.

- **Native Sharing.** Isolates map the same backing allocation, so a 256 MiB arena costs about 4 MiB
  to attach to another isolate instead of a copy.
- **Serial Semantics.** Uncertain dependencies run on private overlays and commit in original
  order. A conflict replays against committed state, and a trap keeps its preceding writes.
- **Original Stack.** JSPI suspends the program's own Wasm stack at joins, so branches, scalar
  carry and host effects behave as they do natively.
- **Portable.** The client and the managed backend use fetch, WebSockets and Durable Objects, with
  no Node imports and no request-time Wasm compilation.

Accepted input does not guarantee a speedup. A program with a true serial dependency runs serially,
and a small job loses to dispatch overhead.

## ✨ Features

- 🧵 **Automatic region discovery** across branches, loops, switches, nested calls and reductions.
- 🧠 **Ordered validation** with byte-granular conflict detection, replay and budget fallback.
- 🛡️ **Native guards** that prove footprints, bounds and finite loops, then run on plain native
  instructions with no tracking.
- 🔌 **Arbitrary Wasm input** as bytes, `ArrayBuffer`, `WebAssembly.Module` or a prepared plan,
  with imported memories, tables, globals and host functions bound as in native instantiation.
- ⏳ **Asynchronous host effects** through JSPI, executed once and in call order.
- 🌐 **Execution host and portable client** for workerd, with sessions, quotas and joined cleanup.
- ☁️ **Managed backend** that runs entirely in Workers and Durable Objects, with binary frames and
  copied snapshots between lanes.
- 🧰 **Task pool** that runs named functions in private contexts on other threads, with ordered
  joins and an optional differential audit.
- 🧊 **Baked boot images** that write a booted memory into the module as data segments.
- 📊 **Opt-in profiling** of worker time, validation, commit and replay cost.

## 📦 Install

```sh
bun add @gmitch215/folio
# or
npm install @gmitch215/folio
```

The Node backend needs Node 26 or later. Async host imports and the managed backend need WebAssembly
JSPI. The browser counted-loop backend works without JSPI; page-owner transports are portable.
Builds from the main branch publish to the `snapshot` tag.

## 🚀 Getting Started

```ts
import { readFileSync } from 'node:fs';
import { Folio } from '@gmitch215/folio';

const folio = await Folio.open(readFileSync('./build/fixture.wasm'), { workers: 4 });
try {
  new Uint32Array(folio.memory.buffer, 1024, 37).fill(1);
  const report = await folio.run('program', [1024, 37, 10000]);
  console.log(report.mode, report.workers, report.regions);
  console.log(folio.inspect('program'));
} finally {
  await folio.close();
}
```

`Folio.open(input, options)` accepts a `Uint8Array`, an `ArrayBuffer`, a `WebAssembly.Module` or the
result of `prepare(bytes)`. A compiled module has no inspectable bytes and uses its native entry.
Imported memory is allocated from the module's limits when omitted. Pass `memory` to bind an
existing single imported memory, or bind several by their exact names in `imports`. Missing host
functions, tables, globals, tags and memory64 bindings are supplied as with native instantiation.
`prepare(bytes, { parallel: 'off' })` disables optimization and leaves the program unchanged.
Prepared plans are trusted build artifacts.

A region runs on a worker only when its estimated work pays for dispatch, joining and validation.
`prepare` estimates each candidate in instruction units, charges 3,600 units for every tracked load
or store, and keeps the region at its owner below `minimumRegionWork` (200,000 by default, about
39 microseconds of native work on an Apple M2 Pro). A loop bounded by a constant uses that count, a
loop bounded by an untouched parameter or a countdown from one is checked against the arguments at
each call, and any other loop is assumed to run `assumedTripCount` times (1,000). A module with no
region above the threshold gets no control plan and runs as the original Wasm, so a small kernel, a
memory-bound loop or a serial recurrence stays at native speed. `minimumRegionWork: 0` admits every
pure region. `folio.diagnostics` says why a plan was refused.

## ⏳ Asynchronous Host Effects

```ts
import { Folio, suspending } from '@gmitch215/folio';

const folio = await Folio.open(module, {
  imports: {
    host: {
      read: suspending(async (key) => (await fetch(new URL(String(key), storageUrl))).status)
    }
  },
  promising: ['main']
});
const report = await folio.run('main', [42]);
await folio.close();
```

This needs a runtime with WebAssembly JSPI. Listed async exports and numeric-result coordinator
entries receive a promising wrapper. Reference-returning exports keep their native ABI, because
Promise assimilation would change an externref Promise's identity. Host effects run once in call
order and exceptions keep their identity. Opaque references stay in the original isolate. Closing
joins a suspended native call; it cannot cancel an arbitrary external Promise.

## 🌉 Execution Host

`@gmitch215/folio/host` registers trusted artifacts, bindings and export allowlists through
`FolioHost`. Its authenticated fetch handler exposes ordered run, read, write and close operations
with joined disposal and bounded admission. `@gmitch215/folio/remote` is the client for it.

```ts
import { RemoteFolio } from '@gmitch215/folio/remote';

const remote = await RemoteFolio.open(endpoint, 'fixture', {
  headers: { authorization: `Bearer ${token}` },
  workers: 4
});
try {
  await remote.write(1024, inputBytes);
  const report = await remote.run('program', [1024, wordCount, rounds]);
  const output = await remote.read(1024, inputBytes.length);
} finally {
  await remote.close();
}
```

The client runs in stock workerd with no Node imports and no runtime Wasm compilation. Requests and
results cross a serialized transport, and physical sharing happens inside the host. Each session
caches its last accepted result, so `retryPending()` recovers a lost response without repeating
effects. The cache is bounded and held in memory. Memory admission checks the initial accessible
backing, and trusted artifact factories enforce growth maxima and private-memory budgets.

## 📡 Managed Workers

`@gmitch215/folio/managed` exports `ManagedFolio` and `FolioLane` for execution entirely in managed
Workers and Durable Objects. `ManagedFolio` takes precompiled artifact modules and lane transports
whose `execute(frame)` returns a binary response, and `FolioLane` runs the tracked region module.
The original JSPI coordinator keeps control flow and host effects, and copied snapshots with
ordered byte validation connect independent lanes. A transport failure falls back to native owner
execution. Snapshot, frame, fuel and tracking bounds are configurable, and the canonical memory
must fit the owner runtime. See [the managed procedure](experiments/managed/METHOD.md).

## 🔗 Browser Execution and Page Leases

`@gmitch215/folio/browser` exports `BrowserFolio` for Chromium and other hosts without JSPI. It
takes a precompiled original module and the `loops`, `native`, `reasons` and `memories` metadata
that `prepare` produced offline. `open()` attaches dedicated module workers to the supplied shared
memory. `run(name, args)` derives guarded partitions from one ordinary counted-loop call and joins
before it returns, with no snapshot and no runtime compiler. Other entries use the original owner.
The caller keeps exclusive ownership of the arena. A failure after native writes closes the pool,
and the application restores a checkpoint before retrying.

`@gmitch215/folio/pages` exports `PageDirectory`, `MemoryPageOwner`, `ResidentPageLease` and the
`PageOwner` transport contract. `acquire({ read, write })` obtains bounded resident pages and
`lease.view(page)` returns a private view of one. `commit()` stages immutable versions and
atomically publishes their manifest, `abort()` discards local changes, and `collect()` reclaims
retired versions with delayed-message fencing. The directory holds page metadata, not a whole heap.

Leases work on copied bytes, and the bundled owners and directory keep their state in memory. The
[technical report](TECHNICAL_REPORT.md) covers failure semantics, the native Wasm measurements and
the limits of both modules.

## 🧰 Task Pool

`@gmitch215/folio/tasks` runs independent work that a program names itself. A `TaskPool` owns one
channel per worker. The caller starts each worker with `pool.link(index)` and calls `serveTasks`
there with a function that runs a named task. The owner calls `submit(name, input)` and keeps going,
then `join(handle)` blocks until the output arrives, or `joinAsync(handle)` waits without blocking
the event loop. `run(jobs)` submits a list and returns the results in submission order, and
`runSync(jobs)` does the same where the caller cannot yield, such as inside a synchronous Wasm
import. Input and output are strings or bytes, `submitJson` and `result.json()` cover structured
values, and `pool.width` limits how many workers take tasks.

```ts
import { Worker } from 'node:worker_threads';
import { TaskPool } from '@gmitch215/folio/tasks';

const pool = new TaskPool(4);
for (let index = 0; index < pool.size; index++) {
  const link = pool.link(index);
  new Worker(new URL('./task-worker.js', import.meta.url), {
    workerData: { link },
    transferList: [link.port]
  });
}

const results = await pool.run([
  ['render', 'page-1'],
  ['render', 'page-2']
]);
console.log(results.map((result) => result.text()));
```

```ts
import { workerData } from 'node:worker_threads';
import { serveTasks } from '@gmitch215/folio/tasks';

serveTasks(workerData.link, (name, input) => {
  // run the task called `name` on `input` and return its output
  return String(input);
});
```

A worker shares nothing with the owner. Each task runs against that worker's own state, so a task
that reads or writes state the serial program would have shared returns a different result than the
serial run. `audit: { run, every }` runs every nth task again in the joining thread and throws
`TaskConflictError` with the first differing byte. The audit costs one serial execution per checked
task and is meant for tests and canaries. `drain()` returns a record per joined task with its worker,
start and end time, thread CPU time and byte counts, and `peakConcurrency(records)` reports how many
tasks ran at the same time.

The pool does not discover independent work. Region discovery and ordered validation stay in the
core engine, and the task pool covers programs that can say which calls are independent.

## 🧊 Baked Boot Images

`@gmitch215/folio/bake` moves a booted memory into the module. `captureImage(booted, fresh)` compares
a booted memory with a fresh instance of the same module and keeps the 64 KiB pages that differ.
`bakeModule(bytes, image)` returns the module with those pages as active data segments after its own,
so instantiating it starts from the booted memory. It uses binaryen, loaded on the first bake, and
writes memory 0.

```ts
import { bakeModule, captureImage, imagePages, moduleDigest } from '@gmitch215/folio/bake';

const fresh = new WebAssembly.Memory({ initial: 1024 });
const booted = new WebAssembly.Memory({ initial: 1024 });
// instantiate `bytes` on each memory, then run the boot sequence on `booted`

const image = captureImage(booted, fresh, { module: await moduleDigest(bytes) });
const baked = await bakeModule(bytes, image);

const memory = new WebAssembly.Memory({ initial: imagePages(image).memoryPages });
const { instance } = await WebAssembly.instantiate(baked, { env: { memory } });
```

The caller creates an imported memory with at least `memoryPages` pages. A defined memory that
starts smaller has its initial pages raised to the image size, and its maximum, shared and memory64
flags stay as they are. A page that boot zeroed but the module's own data had set is stored as
zeros, and pages that are zero in both are left out. Pass the global values and the function table
of both instances to `captureImage` as `globals` and `table` and the image records what boot
changed. `bakeModule` writes changed i32, i64, f32 and f64 globals into their initial values and
refuses changed table slots unless `allowTableChanges` is set. It throws `ImageMismatchError`, which
has a `code`, for a wrong module digest, no memory, an image over the memory maximum and a global it
cannot rewrite. Adjacent pages become one segment of at most `maxSegmentBytes` (64 MiB).

`applyImage(memory, image)` copies the pages into a fresh instance's memory without baking.
`captureImage` takes a `context` string beside the module digest, a digest of whatever else shapes
the heap (settings, shims, assets), and `applyImage(memory, image, { module, context })` refuses an
image whose module or context differs, or that carries none, with `ImageMismatchError` code `digest`
or `context` and before it writes a byte. `encodeImage` and `decodeImage` store an image beside the
module and reject truncated or unknown input with `ImageFormatError`. `checkBaked(baked, image)`
reads the data segments back and compares them with the image without instantiating.
`bakeModule` throws code `memories` for a module with more than one memory.

The image is the heap as it was, so anything the booted process held is in the baked module and
becomes public with it. State kept in JavaScript, such as handles and open descriptors, is not
captured. `findInImage(image, needles)` returns every offset where a needle's bytes occur in the
image pages, so a secret and its base64 and hex forms can be searched for before the module ships.
Freed memory is not zeroed, so a secret that was ever in the heap cannot be scrubbed out of an
image afterwards: bake a site whose key and salt are throwaway values, and give the replaying site
its own.

For a Drupal heap that means three replacements after the replay. The hash salt lives in the static
`Settings` object; the private key lives in the `State` cache collector, which serves it from memory
once read; and PHP's Mersenne Twister state is in the heap, so every replayed instance would draw
the same `mt_rand()` sequence. Values the bake computed from the old key and salt, such as the
permissions hash of the anonymous user, sit in the `cache.memory` bin. This snippet makes the
replayed instance use the replaying site's values, with `$salt` set to that site's hash salt:

```php
use Drupal\Core\Site\Settings;

(function (string $salt) {
	$this->storage['hash_salt'] = $salt;
})->call(Settings::getInstance(), $salt);

(function () {
	$this->reset();
	$this->keysSetDuringRequest = [];
})->call(Drupal::state());

Drupal::service('cache.memory')->deleteAll();
mt_srand(unpack('V', random_bytes(4))[1]);
```

Run it before any other PHP in the replayed instance. A host that resets `State` at the start of
each request still needs the salt and the random seed, and needs the key step for code that runs
before the first request. The measured effect for a PHP interpreter is in the Baked Boot Images
section of the technical report.

## 🧱 Execution and Memory

Proved finite, nontrapping i32 kernels use runtime bounds and cross-region overlap checks, then
run native instructions against the shared allocation with no tracking or commit copy. A failed
guard falls back to tracked execution.

Tracked regions read a frozen shared base and keep private byte overlays. Once every reader stops,
Folio validates and commits in order. Conflicts replay against committed state, budgets discard
speculation, and ordered traps keep their preceding writes while later results are discarded.

The coordinator keeps admitted scalar control flow and live results. Inline numeric-memory spans
become regions when modified locals have no external live-outs and are assigned before reads on
every admitted path. Pure nonrecursive calls with unused results also qualify. Opaque functions,
recursion, host effects and state operations join preceding regions and run at their original
owner. Transactional memory covers i32, i64, f32 and f64 scalar operations plus `memory.copy` and
`memory.fill`, including unaligned access, overlap, NaN payloads, bounds and traps. Growth and
initialization stay at the coordinator. Unsupported instructions, reference and vector state,
memory64 and multiple memories keep native execution.

Shared source memory has zero-copy physical backing across the worker group. Ordinary source memory
keeps its original identity and buffer semantics, with an explicit shared snapshot per speculative
batch and ordered writeback, and the report counts the snapshot bytes. Regions travel in batches of
up to 16 per worker, and a singleton at a join runs locally.

Each isolate keeps its own stack, globals, table, JS heap and instance. Shared linear bytes do not
merge GC heaps or make arbitrary callbacks transferable. Give Folio exclusive access to its
memories and native exports until a run settles, and refresh views after shared growth. A failure
during direct native writes can leave partial memory, so the failed group closes and the
application restores a checkpoint before retrying. Instruction-defined traps keep their order and
writes. Native stack capacity and allocation failure can differ between isolates.

## 📖 API Reference

| Member                                 | Contract                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| `run(name, args?, options?)`           | One entry, automatic region discovery when supported                         |
| `runAll([{ export, args }], options?)` | Ordered sequence of calls; the lower-level speculation primitive             |
| `inspect(name)`                        | Automatic plan and native guard availability, with analysis diagnostics      |
| `diagnostics`                          | Module-wide optimization refusals                                            |
| `capabilities`                         | Active same-process sharing, automatic extraction and validation mode        |
| `memory`                               | The unique accessible arena, including a coordinator-exposed hidden memory   |
| `memories`                             | Named imported and exported memory wrappers                                  |
| `exports`                              | Original native exports for trusted host integration                         |
| `close()` and async disposal           | Join worker termination and outstanding JSPI calls; repeated close shares it |

A run returns `values`, `mode`, participating `workers`, `regions`, `replayed`, `fallbacks` and an
optional routing `reason`. Generalized execution also reports `extraction`, `memoryMode` and
`snapshotBytes`. Mode is `serial`, `speculative` or `native-shared`, and a serial run reports zero
participating workers. An analysis refusal is distinct from a runtime dependency, a failed guard
and a small-workload decision.

Run options:

- `parallel: 'auto' | 'off' | 'speculate'` chooses automatic routing, original execution or tracked
  regions.
- `maximumWorkers` caps participating workers without recreating the group, which limits
  contention or leaves CPU for other jobs.

Pool options are `workers` (up to four by default), `memory`, `imports`, `minimumParallelWork`
(100,000 estimated iterations for proved kernels), `minimumRegionWork` and `assumedTripCount` (both
apply when `open` prepares raw bytes), `fuel` (100,000,000), `maxTransactionBytes` (262,144),
`promising` and `profile`. A one-worker pool uses its native entry and creates no idle
worker.

Profiling is opt-in. `report.profile` holds elapsed time, worker observations, validation, commit
and replay time, and tracked read and write bytes. On generalized batches `workerWallMs` and
`workerCpuMs` hold per-region observations. Measure process CPU once at the coordinator, because
summing overlapping process-wide counters double counts.

The generated API reference is published to GitHub Pages from `bun run docs:build`.

## 🧪 Consumer Harness

`scripts/probe/consumer.ts` measures any Wasm module against a native instance of itself. A consumer
file exports the module bytes, a factory for fresh imports and a list of cases. Each case prepares
state on the raw exports and returns the calls to time. The harness opens a native arm and one pool
per worker count, alternates the arms inside every round, and compares the whole memory and every
return value before it records a sample. A mismatch stops the run.

```sh
node scripts/probe/consumer.ts scripts/probe/consumers/tinyimg.ts results/mine/tinyimg.jsonl 20 1,2,4,8
bun scripts/analyze/paired.ts mine tinyimg.jsonl
```

`FOLIO_OLD_BUILD=1` adds an `old-N` arm per worker count that runs the archived source from before
static admission (`results/20261020-regress/old-build-src.tar.gz`), alternating with the current
build in the same rounds. The summary then reports `versusOld`, the old build's wall time divided by
the current one.

Every row carries wall time, process CPU and what Folio dispatched: workers, regions, replays,
fallbacks, mode and the reason it stayed serial. The closing row holds `inspect` coverage for each
entry that ran. The summary reports the paired speedup (native over Folio, within each round) and
the CPU ratio, so a run that finds nothing to split says so with its numbers. The consumers in
`scripts/probe/consumers/` cover tinyimg, a Linux machine core and a process ABI probe, a serial
recurrence, the compute kernel and a kernel whose trip count is too small to pay for dispatch.
`scripts/probe/php-workloads.ts` runs the same comparison on a PHP 8.5 build that serves Drupal.

`scripts/probe/php-contexts.ts` opens N private PHP instances, one per worker thread, and runs a
snippet or the uncached Drupal render in each. Every result carries timestamps from inside the
thread and thread CPU, so a run can show that two instances executed at the same time.
`scripts/probe/php-concurrent.ts` uses it for the four-arm comparison of independent requests
(native serial, native concurrent, Folio serial, Folio concurrent). Independent requests scale
with the number of instances whether or not Folio is involved; the library adds nothing to that
result and the numbers are in the technical report.

`scripts/probe/php-regen.ts` regenerates a set of Drupal pages with private contexts pulling from
one queue and aborts if any page differs from the serial render. On ten cores it reproduced 31 pages
7.65x faster than one context. It also runs under Bun, which the task pool supports.

## 📈 Measured Results

| Backend                      | Environment                                                        | Result                                                                                             |
| ---------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Node, shared allocation      | Ryzen 9 9900X, eight pinned workers, 256 MiB arena                 | 7.52x median elapsed speedup on a normally inlined C entry, 4.87% extra CPU work, every byte exact |
| Node, compute kernel         | eight workers, 207 byte-exact samples                              | 7.62x, with total CPU 1.037x of serial                                                             |
| Node, Drupal regeneration    | Ryzen 9 9900X, ten private contexts, 31 pages, n=20                | 7.65x median over one context, 1.087x process CPU, every page equal to the serial render           |
| Managed Workers              | deployed Durable Object lanes                                      | 39 of 39 rows exact over RPC, fetch, streams and WebSockets; 1.62x end to end at four lanes        |
| Browser Run                  | deployed Chromium, eight workers on one 256 MiB allocation         | 3.87x with four workers on explicit partitions                                                     |
| Browser automatic extraction | FREE account, no JSPI, one ordinary counted-loop call over 256 MiB | 3.45x at eight workers, all memory and returns exact; n=3 exploratory wall time                    |

A streaming workload stops improving near four workers, and `maximumWorkers` caps the pool per run.
Managed Workers cannot share physical memory across isolates, so that backend copies snapshots. The
[technical report](TECHNICAL_REPORT.md) lists every figure with its instrument, the raw samples
live in [results/](results), and the Cloudflare probes are described in
[experiments/](experiments/README.md).

## 🔧 Development

```sh
bun install
bun run build:c # compile the C fixtures in tests/c with LLVM
bun run typecheck
bun run test             # unit gate
bun run test:integration # local workerd probes and the managed lanes
bun run build
bun run example
```

Fixtures need `clang` and `wasm-ld` with the `wasm32` target. Tests need Node 26 for JSPI.
`bun run test:coverage` runs the unit and integration projects with coverage, and `bun run
test:e2e` deploys the probes to a Cloudflare account when `FREE_CLOUDFLARE_ACCOUNT_ID` and
`FREE_CLOUDFLARE_API_TOKEN` are set. Layout notes live in [tests/](tests/README.md),
[scripts/](scripts/README.md) and [experiments/](experiments/README.md).

## 🤝 Contributing

Open an issue before a large change. Run `bun run typecheck`, `bun run test` and
`bun run prettier:check` before sending a pull request. Changes to the compiler need a differential
test against native execution, and a performance claim needs a paired measurement with its raw
samples.

## 📄 License

MIT. See [LICENSE](LICENSE).
