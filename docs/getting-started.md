# Getting Started

This page installs Folio, runs one program, reads the report and picks the route that fits a
workload. The [README](../README.md) shows the same first call in less space, and the
[module pages](modules/README.md) cover each subpath in depth.

## Install

```sh
bun add @gmitch215/folio
# or
npm install @gmitch215/folio
```

The Node backend needs Node 26 or later. Async host imports and the managed backend need WebAssembly
JSPI. The examples in the repository need the C fixtures and the package build:

```sh
bun install
bun run build:c
bun run build
```

`bun run build:c` needs `clang` and `wasm-ld` (the `lld` package) on `PATH`.

## Run One Program

`examples/basic.ts` opens a prepared module with a shared memory, runs one export and closes the
pool:

```ts
import { Folio, prepare } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

const program = prepare(readFileSync(new URL('../build/fixture.wasm', import.meta.url)));
const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
new Uint32Array(memory.buffer, 1024, 37).fill(1);

const folio = await Folio.open(program, { memory, workers: 4 });
try {
  const report = await folio.run('program', [1024, 37, 10000]);
  console.log(report);
  console.log(new Uint32Array(folio.memory.buffer, 1024, 4));
} finally {
  await folio.close();
}
```

`prepare(bytes)` analyses the module once. It keeps the original native module and adds a plan for
the regions it can prove or track. A module that has no region worth dispatching gets no plan and
runs as the original Wasm. `Folio.open` takes the plan, or raw bytes, which it prepares itself. The
`memory` is shared so that every worker reads and writes the same bytes. `workers: 4` is the default
when the machine has four cores or more. `run(name, args)` calls one export, and `close()` joins the
workers and any suspended native call.

Run it with `node examples/basic.ts`. After the report, the last line prints the first four words of
the arena.

## Read the Report

`run` returns a report. The one from the example above is:

```text
{
  values: [ undefined ],
  workers: 4,
  regions: 4,
  replayed: 0,
  fallbacks: 0,
  mode: 'native-shared'
}
```

| Field       | Meaning                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `values`    | The return values of the call, or of each call in a batch.                                                                       |
| `mode`      | `native-shared` ran proved kernels on the shared allocation, `speculative` ran tracked regions, `serial` ran the original entry. |
| `workers`   | Workers that executed regions. A serial run reports zero.                                                                        |
| `regions`   | Regions discovered and dispatched.                                                                                               |
| `replayed`  | Regions that conflicted and replayed against committed state.                                                                    |
| `fallbacks` | Regions or batches that fell back to native execution at the owner.                                                              |
| `reason`    | Why a run stayed serial or left the fast path, such as `small-workload`, `no-parallel-plan` or `dependency`.                     |

A call that is too small to pay for dispatch stays serial and says so. `examples/routing.ts` runs a
small call, a large call, a capped call and a dependent call, and prints one line each:

```text
small work { mode: 'serial', workers: 0, reason: 'small-workload' }
large work { mode: 'native-shared', workers: 4, reason: undefined }
capped { mode: 'native-shared', workers: 2, reason: undefined }
dependent 0 { mode: 'speculative', workers: 4, reason: 'dependency' }
```

Check the report before assuming a call ran in parallel. `folio.inspect(name)` and
`folio.diagnostics` say why a plan was refused. [Core](modules/core.md) lists every report field and
option.

## Choose a Route

The right entry depends on who can say which work is independent.

| Workload                                                                    | Use                                                          | Page                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------- |
| One ordinary entry with inline loops or pure calls                          | `Folio.run`                                                  | [Core](modules/core.md)                                     |
| A loop of per-record calls over a shared memory                             | `Folio.run`, which runs the iteration route and validates it | [Core](modules/core.md), [Pools](modules/pools.md)          |
| A batch of jobs you can name, each with its own state                       | `TaskPool`                                                   | [Pools](modules/pools.md)                                   |
| Records in one memory, one exported function, calls you declare independent | `SlicePool`                                                  | [Pools](modules/pools.md)                                   |
| One CRC-32, Adler-32 or AES-CTR stream                                      | `foldChunks`, or `certifyStream` with `foldCertified`        | [Folds and Certificates](modules/folds-and-certificates.md) |
| A record loop whose driver writes fixed-address scratch                     | `certifyOwnership` with `ownershipSlices`                    | [Folds and Certificates](modules/folds-and-certificates.md) |
| A call where you want the route chosen and explained                        | `Router`                                                     | [Folds and Certificates](modules/folds-and-certificates.md) |
| A private instance reset between jobs                                       | `InstanceCheckpoint`                                         | [Core](modules/core.md)                                     |
| Execution in Workers and Durable Objects                                    | `ManagedFolio` and `FolioLane`                               | [Workers](modules/workers.md)                               |
| A browser without JSPI                                                      | `BrowserFolio`                                               | [Browser](modules/browser.md)                               |
| A memory cap, a page directory or a booted heap                             | `governGrowth`, `PageDirectory`, `bakeModule`                | [Memory](modules/memory.md), [Boot](modules/boot.md)        |
| A guest that needs more CPU than one Durable Object event allows            | `runSlice`                                                   | [Continuation](modules/continuation.md)                     |

Accepted input does not guarantee a speedup. A program with a true serial dependency runs serially,
and a small job loses to dispatch overhead. [Limits](limits.md) lists what does not parallelize and
which gates were not met.

## Where to Go Next

- [Modules](modules/README.md) maps the six subpaths and helps choose between them.
- [Configuration](configuration.md) lists every option with its type and default.
- [Advanced Usage](../ADVANCED_USAGE.md) combines the modules for specialised cases.
- The [technical report](../TECHNICAL_REPORT.md) holds the evidence, the instruments and the open
  questions.
