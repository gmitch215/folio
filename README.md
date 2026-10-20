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
- [Execution and Memory](#-execution-and-memory)
- [API Reference](#-api-reference)
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
- 📊 **Opt-in profiling** of worker time, validation, commit and replay cost.

## 📦 Install

```sh
bun add @gmitch215/folio
# or
npm install @gmitch215/folio
```

Folio needs Node 26 or later. Async host imports and the managed backend need WebAssembly JSPI.
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
(100,000 estimated iterations for proved kernels), `fuel` (100,000,000), `maxTransactionBytes`
(262,144), `promising` and `profile`. A one-worker pool uses its native entry and creates no idle
worker.

Profiling is opt-in. `report.profile` holds elapsed time, worker observations, validation, commit
and replay time, and tracked read and write bytes. On generalized batches `workerWallMs` and
`workerCpuMs` hold per-region observations. Measure process CPU once at the coordinator, because
summing overlapping process-wide counters double counts.

The generated API reference is published to GitHub Pages from `bun run docs:build`.

## 📈 Measured Results

| Backend                 | Environment                                                | Result                                                                                             |
| ----------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Node, shared allocation | Ryzen 9 9900X, eight pinned workers, 256 MiB arena         | 7.52x median elapsed speedup on a normally inlined C entry, 4.87% extra CPU work, every byte exact |
| Node, compute kernel    | eight workers, 207 byte-exact samples                      | 7.62x, with total CPU 1.037x of serial                                                             |
| Managed Workers         | deployed Durable Object lanes                              | 39 of 39 rows exact over RPC, fetch, streams and WebSockets; 1.62x end to end at four lanes        |
| Browser Run             | deployed Chromium, eight workers on one 256 MiB allocation | 3.87x with four workers on explicit partitions                                                     |

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
