# 🚋 Folio

> ⚡ WebAssembly tooling for Node, Workers and browsers

Folio is a toolkit for running, resetting and bounding WebAssembly modules in JavaScript runtimes.
Its core runs native WebAssembly across several V8 isolates that share one physical memory
allocation. It finds inline memory regions and pure calls in ordinary programs, validates the ones
it cannot prove independent, and keeps the serial result. Around the core sit task and slice pools,
exact stream folds, instance checkpoints, baked boot images, a growth governor and a portable client
for workerd and managed Cloudflare Workers.

## Table of Contents

- [Why Folio](#-why-folio)
- [Features](#-features)
- [Install](#-install)
- [Getting Started](#-getting-started)
- [Examples](#-examples)
- [Modules](#-modules)
- [Limits](#-limits)
- [Development](#-development)
- [Contributing](#-contributing)
- [License](#-license)

## 🧭 Why Folio

A Worker, a Linux machine in a Durable Object and a PHP interpreter all end up as one Wasm instance
on one thread. Folio spreads the work of that instance across cores without asking the program to be
rewritten. The caller passes one ordinary entry point, and the compiler discovers the regions. The
task pool, slice pool and chunked recurrences take a caller declaration instead, and the report says
which checks each route runs. The same package manages the instance itself: it resets a private
instance between jobs, starts a module from a booted heap and refuses memory growth past a cap.

- **Native Sharing.** Isolates map the same backing allocation. Four isolates attach to a touched 64
  MiB backing for 3.871 MiB of additional resident memory, against 259.930 MiB for copied buffers.
- **Serial Semantics.** On the automatic routes, uncertain dependencies run on private overlays and
  commit in original order. A conflict replays against committed state, and a trap keeps its
  preceding writes.
- **Original Stack.** JSPI suspends the program's own Wasm stack at joins, so branches, scalar carry
  and host effects behave as they do natively.
- **Instance Control.** Checkpoints restore a private instance between jobs, boot images start a
  module from a booted memory, and the growth governor turns an oversized allocation into a failure
  the guest can report.
- **Portable.** The client and the managed backend use fetch, WebSockets and Durable Objects, with
  no Node imports and no request-time Wasm compilation.

Accepted input does not guarantee a speedup. A program with a true serial dependency runs serially,
and a small job loses to dispatch overhead.

## ✨ Features

| Feature                                                                           | What it does                                                                                              | Module                                                           |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Region discovery, ordered validation, native guards and asynchronous host effects | Runs one ordinary entry on several cores and keeps the serial result                                      | [Core](docs/modules/core.md)                                     |
| Task pool and slice pool                                                          | Run named tasks in private contexts, or slices of a call range in place on one shared memory              | [Pools](docs/modules/pools.md)                                   |
| Exact chunked recurrences and certified stream folds                              | Split one CRC-32, Adler-32 or AES-CTR stream across workers and join the chunk states                     | [Folds and Certificates](docs/modules/folds-and-certificates.md) |
| Ownership certificates and the router                                             | Prove that a record loop keeps its scratch private, and pick a route per call with a stated reason        | [Folds and Certificates](docs/modules/folds-and-certificates.md) |
| Execution host and instance checkpoints                                           | Serve a program over an authenticated fetch handler, and restore a private instance between jobs          | [Core](docs/modules/core.md)                                     |
| Managed Workers and portable client                                               | Run entirely in Workers and Durable Objects, with binary frames and learned byte ranges between lanes     | [Workers](docs/modules/workers.md)                               |
| Browser backend                                                                   | Attach Web Workers to one shared memory, with page leases for transports that copy bytes                  | [Browser](docs/modules/browser.md)                               |
| Growth governor, page directory and leases                                        | Refuse `memory.grow` past a byte cap, and hold bounded resident pages                                     | [Memory](docs/modules/memory.md)                                 |
| Baked boot images                                                                 | Write a booted memory into the module as data segments                                                    | [Boot](docs/modules/boot.md)                                     |
| Continuations                                                                     | Run a Wasm guest across Durable Object alarm events with page-hash checkpoints in SQLite                  | [Continuation](docs/modules/continuation.md)                     |
| Profiling and the consumer harness                                                | Time worker, validation, commit and replay cost, and time any Wasm module against a native instance of it | [Core](docs/modules/core.md)                                     |

## 📦 Install

```sh
bun add @gmitch215/folio
# or
npm install @gmitch215/folio
```

The Node backend needs Node 26 or later. Async host imports and the managed backend need WebAssembly
JSPI. The browser counted-loop backend works without JSPI, and page-owner transports are portable.
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
result of `prepare(bytes)`. `folio.run` returns a report that names the mode (`serial`,
`speculative` or `native-shared`), the workers that took part and the reason a call stayed serial. A
region runs on a worker only when its estimated work pays for dispatch, joining and validation, so a
small kernel, a memory-bound loop or a serial recurrence stays at native speed.
[Getting Started](docs/getting-started.md) walks through the report and the choice between routes.

## 🧩 Examples

The [examples](https://github.com/gmitch215/folio/tree/master/examples) run against the built
package with `node examples/<name>.ts` after `bun run build:c` and `bun run build`:

- `basic` runs one entry.
- `routing` reads the report and shows capped and adaptive routing.
- `iteration` runs a loop of per-record calls on workers over a shared memory and compares the
  digests with the serial run.
- `context-reset` resets a private instance between jobs.
- `task-pool` joins independent jobs in order.
- `slice-pool` fills one shared memory from several threads and audits the run against the serial
  one.
- `boot-image` bakes captured memory into a module.
- `growth-governor` caps `memory.grow` on a guest's memory and shows the guest's failed allocation.
- `continuation` runs a guest across alarm events with checkpoints in storage.

[Advanced Usage](ADVANCED_USAGE.md) combines these for specialised cases.

## 🗂️ Modules

Folio has six subpaths. Each one names a runtime boundary or a feature.

| Import                          | Runs on                     | Purpose                                                                                             | Page                                         |
| ------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `@gmitch215/folio`              | Node                        | `Folio`, the compiler, folds, certificates, the router, task and slice pools, the execution host    | [Core](docs/modules/core.md)                 |
| `@gmitch215/folio/workers`      | Workers and Durable Objects | `ManagedFolio`, `FolioLane`, the remote client `RemoteFolio` and the frame and value codecs         | [Workers](docs/modules/workers.md)           |
| `@gmitch215/folio/browser`      | Browsers without JSPI       | `BrowserFolio`, which runs one counted-loop call on shared memory                                   | [Browser](docs/modules/browser.md)           |
| `@gmitch215/folio/memory`       | Portable                    | Page directories and leases, the growth governor and elastic regions                                | [Memory](docs/modules/memory.md)             |
| `@gmitch215/folio/boot`         | Portable                    | Boot images: `bakeModule`, `captureImage`, `applyImage`, `checkBaked` and the image errors          | [Boot](docs/modules/boot.md)                 |
| `@gmitch215/folio/continuation` | Portable                    | Wasm guests across Durable Object alarm events, with page-hash checkpoints in Durable Object SQLite | [Continuation](docs/modules/continuation.md) |

[Modules](docs/modules/README.md) helps choose between them, and
[Configuration](docs/configuration.md) lists every option. Subpaths from 1.1 that are not in this
table are no longer exported, and the
[CHANGELOG](https://github.com/gmitch215/folio/blob/master/CHANGELOG.md) lists where each of their
names moved. The generated API reference is published to GitHub Pages from `bun run docs:build`.

## ⚠️ Limits

Folio keeps the serial result and does not promise a speedup. The automatic routes found no gain on
independent library kernels and on three unmodified outside programs, and the explicit routes win
where the caller names the independent work. [Limits](docs/limits.md) lists what does not
parallelize, the gates that were not met and the platform limits, and the
[technical report](TECHNICAL_REPORT.md) holds the figures, the instruments and the raw samples under
[results](https://github.com/gmitch215/folio/tree/master/results).

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
`bun run test:coverage` runs the unit and integration projects with coverage, and `bun run test:e2e`
deploys the probes to a Cloudflare account when `FREE_CLOUDFLARE_ACCOUNT_ID` and
`FREE_CLOUDFLARE_API_TOKEN` are set. The experiments also accept `FOLIO_CLOUDFLARE_ACCOUNT_ID` and
`FOLIO_CLOUDFLARE_API_TOKEN`. Layout notes live in
[tests/](https://github.com/gmitch215/folio/blob/master/tests/README.md),
[scripts/](https://github.com/gmitch215/folio/blob/master/scripts/README.md) and
[experiments/](https://github.com/gmitch215/folio/blob/master/experiments/README.md).

## 🤝 Contributing

Open an issue before a large change. Run `bun run typecheck`, `bun run test` and
`bun run prettier:check` before sending a pull request. Changes to the compiler need a differential
test against native execution, and a performance claim needs a paired measurement with its raw
samples.

## 📄 License

MIT. See [LICENSE](https://github.com/gmitch215/folio/blob/master/LICENSE). The documentation
favicons in `docs/` are the Fluent UI Emoji tram car from Microsoft, licensed under MIT.
