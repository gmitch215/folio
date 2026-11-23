# Core

The `@gmitch215/folio` entry runs a WebAssembly module across several V8 isolates that share one
physical memory allocation. It finds inline memory regions and pure calls in ordinary programs,
validates the ones it cannot prove independent, and keeps the serial result. The same entry holds
the execution host, asynchronous host effects and instance checkpoints. The pools, folds,
certificates and router that share the entry have their own pages: [Pools](pools.md) and
[Folds and Certificates](folds-and-certificates.md).

## Overview

Use the core when a program has independent work inside one call or a loop of calls, and you want
the serial result without rewriting the program. The caller passes one ordinary entry point. On the
automatic routes there are no access annotations and no caller-created chunks.

`Folio.open` takes the module bytes, `folio.run(name, args)` calls one export, and the returned
report says what ran. This is the output of `examples/basic.ts` against the fixture module:

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

`mode` is `native-shared` when proved kernels ran on the shared allocation with no tracking,
`speculative` when tracked regions ran on private overlays and committed in order, and `serial` when
the original entry ran. A serial run reports zero workers and usually a `reason`.

The entry also exports the pieces that surround a run:

- **Asynchronous host effects.** JSPI suspends the program's own Wasm stack while a host import
  awaits, and effects run once and in call order.
- **Execution host.** `FolioHost` serves one program to a remote client over an authenticated fetch
  handler.
- **Instance checkpoints.** `InstanceCheckpoint` restores a private instance between independent
  jobs.

## Getting Started

The smallest program opens the module with a shared memory, runs one export and closes the pool.
This is `examples/basic.ts`:

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

`prepare(bytes)` analyses the module once and returns a plan that keeps the original native module
beside the optimized one. `Folio.open(input, options)` accepts that plan, a `Uint8Array`, an
`ArrayBuffer` or a `WebAssembly.Module`. A compiled module has no inspectable bytes and uses its
native entry. The shared `memory` is what lets workers read the same bytes without a copy, and
`close()` joins the workers and any suspended native call.

Build the fixtures first with `bun run build:c`, then run the file with `node examples/basic.ts` on
Node 26 or later.

## Intermediate

### Opening a Program

Imported memory is allocated from the module's limits when `memory` is omitted. Pass `memory` to
bind an existing single imported memory, or bind several by their exact names in `imports`. Missing
host functions, tables, globals, tags and memory64 bindings are supplied as with native
instantiation. Prepared plans are trusted build artifacts.

`prepare(bytes, { parallel: 'off' })` disables optimization and leaves the program unchanged.
`folio.inspect(name)` returns the automatic plan and native guard availability for an export, and
`folio.diagnostics` lists the module-wide optimization refusals.

```ts
import { Folio, prepare } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

const bytes = readFileSync(new URL('../build/fixture.wasm', import.meta.url));
const folio = await Folio.open(prepare(bytes, { minimumRegionWork: 0 }), { workers: 4 });
try {
  console.log(folio.inspect('program'));
  console.log(folio.diagnostics);
} finally {
  await folio.close();
}
```

### Admission

A region runs on a worker only when its estimated work pays for dispatch, joining and validation.
`prepare` estimates each candidate in instruction units, charges 3,600 units for every tracked load
or store, and keeps the region at its owner below `minimumRegionWork` (200,000 by default). A loop
bounded by a constant uses that count. A loop bounded by an untouched parameter, or a countdown from
one, is checked against the arguments at each call. Any other loop is assumed to run
`assumedTripCount` times (1,000).

A module with no region above the threshold and no eligible loop gets no control plan and runs as
the original Wasm, so a small kernel, a memory-bound loop or a serial recurrence stays at native
speed. `minimumRegionWork: 0` admits every pure region. [Configuration](../configuration.md) lists
these options with their defaults.

### Loops of Calls

A function with one countdown loop whose iterations are calls, such as a program that hashes several
files, runs its iterations on workers when `memory` is a shared `WebAssembly.Memory`. Iterations
write in place on private stack slots, validate in order and replay serially on a conflict. The
first iteration runs on the owner, and its measured time and the time of each batch decide whether
dispatch continues. A loop that writes more per iteration than the undo log holds, or whose batches
lose to the serial time, finishes serially. With an unshared memory, or one the library cannot grow
by the arena it needs, the run stays serial and the report names the reason.

This is `examples/iteration.ts`. It runs the loop serially for the reference digests, warms the
workers, then times the automatic route:

```ts
import { Folio } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

const bytes = readFileSync(new URL('../build/records.wasm', import.meta.url));
const records = 32;
const size = 1 << 20;
const table = 1024;
const out = 2048;
const data = 1 << 20;
const memory = new WebAssembly.Memory({
  initial: 1 + ((data + records * size) >> 16),
  maximum: 8192,
  shared: true
});

const place = () => {
  const view = new Uint32Array(memory.buffer, table, 2 * records);
  for (let i = 0; i < records; i++) {
    view[2 * i] = data + i * size;
    view[2 * i + 1] = size;
  }
  new Uint8Array(memory.buffer, out, 32 * records).fill(0);
};
const digests = () => Buffer.from(new Uint8Array(memory.buffer, out, 32 * records)).toString('hex');

const folio = await Folio.open(bytes, { memory, workers: 4 });
try {
  for (let i = 0; i < records * size; i += 4099) new Uint8Array(memory.buffer)[data + i] = i;

  place();
  await folio.run('digest_all', [table, records, out], { parallel: 'off' });
  const expected = digests();

  // the first call also warms the workers, so time the second
  place();
  await folio.run('digest_all', [table, records, out]);
  place();
  const report = await folio.run('digest_all', [table, records, out]);

  console.log({
    mode: report.mode,
    extraction: report.extraction,
    reason: report.reason,
    workers: report.workers,
    dispatched: report.iteration?.regions,
    replayed: report.iteration?.replayed,
    stopped: report.iteration?.stopped
  });
  console.log('same digests', digests() === expected);
} finally {
  await folio.close();
}
```

Five `Folio.open` options adjust the iteration route. All five are off by default.

| Option                  | Effect                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iterationReadWindows`  | Learns read windows from the first batch that finishes without a conflict, so loads of the input the iterations stream through set no per-access mark. A window can cost a false conflict, never a different result.                                                                                                         |
| `iterationReadSummary`  | Keeps a summary of the 64-word blocks of each read bitmap that a read touched, so workers scan those blocks and not the whole bitmap. The conflicts found do not change. It adds a few instructions to every tracked read.                                                                                                   |
| `iterationSecondChance` | Judges a loop a little under the dispatch floor on one timed batch, and lets the batches a running loop has shown decide whether the rest pays. A probe that loses ends the dispatch and the loop runs serially for the next 16 calls. The result is the same either way.                                                    |
| `iterationLogCeiling`   | A number of undo entries per iteration. When a batch exhausts the default log, the logs grow to this size and the batch retries once. Unset, that batch finishes serially. On padded LZ4 the retry cost more than the dispatch gained, because ordered validation is quadratic in the logged entries.                        |
| `iterationStall`        | `true` or `{ factor, floorMs }`. Workers poll a stop word at every loop start. A batch that runs past `factor` times the serial time of its iterations (50 by default), and at least `floorMs` (2000 ms), traps and rolls back from the undo logs, and the loop finishes serially with `iteration.stopped` set to `stalled`. |

A program whose iterations can read state another iteration is changing and then loop on it, such as
a linked structure two iterations rewrite, needs `iterationStall`. The poll cost 0.9% to 11.2% of
worker time on the four programs measured
([Architectural Boundaries](../../TECHNICAL_REPORT.md#architectural-boundaries)).

### Run Options and Routing

`parallel` on a run chooses `'auto'` routing, `'off'` for original execution or `'speculate'` for
tracked regions. `maximumWorkers` caps the participating workers without recreating the group, which
limits contention or leaves CPU for other jobs. With `adaptiveRouting` on the pool, a call shape
(entry, width, memory size and numeric arguments) whose last two runs mostly replayed or fell back
runs natively for the next 16 calls and is then probed again.

This is `examples/routing.ts`:

```ts
import { Folio, prepare } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

const program = prepare(readFileSync(new URL('../build/fixture.wasm', import.meta.url)));
const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
const folio = await Folio.open(program, { memory, workers: 4, adaptiveRouting: true });

const show = (label: string, report: Awaited<ReturnType<Folio['run']>>) =>
  console.log(label, { mode: report.mode, workers: report.workers, reason: report.reason });

try {
  new Uint32Array(memory.buffer, 1024, 64).fill(1);
  show('small work', await folio.run('program', [1024, 64, 4]));
  show('large work', await folio.run('program', [1024, 64, 1_000_000]));
  show('capped', await folio.run('program', [1024, 64, 1_000_000], { maximumWorkers: 2 }));
  for (let call = 0; call < 5; call++)
    show(`dependent ${call}`, await folio.run('dependent_program', [1024, 64]));
} finally {
  await folio.close();
}
```

Its output shows the reasons a run leaves the fast path:

```text
small work { mode: 'serial', workers: 0, reason: 'small-workload' }
large work { mode: 'native-shared', workers: 4, reason: undefined }
capped { mode: 'native-shared', workers: 2, reason: undefined }
dependent 0 { mode: 'speculative', workers: 4, reason: 'dependency' }
dependent 1 { mode: 'speculative', workers: 4, reason: 'dependency' }
dependent 2 { mode: 'serial', workers: 0, reason: 'previous-conflicts' }
```

### Reading the Report

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
`snapshotBytes`. A serial run reports zero participating workers. An analysis refusal is distinct
from a runtime dependency, a failed guard and a small-workload decision.

Profiling is opt-in through the `profile` pool option. `report.profile` then holds elapsed time,
worker observations, validation, commit and replay time, and tracked read and write bytes. On
generalized batches `workerWallMs` and `workerCpuMs` hold per-region observations. Measure process
CPU once at the coordinator, because summing overlapping process-wide counters double counts.

### Asynchronous Host Effects

A host import that awaits runs through JSPI, which suspends the program's own Wasm stack at the
call. Wrap the import with `suspending` and list the exports that return a Promise in `promising`.
The module here imports `host.read` and exports `main`. Host effects run once and in call order, and
exceptions keep their identity.

```ts
import { Folio, suspending } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

const bytes = readFileSync(new URL('./program.wasm', import.meta.url));
const storageUrl = 'https://storage.example/';

const folio = await Folio.open(bytes, {
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
Promise assimilation would change an externref Promise's identity. Opaque references stay in the
original isolate. Closing joins a suspended native call and cannot cancel an arbitrary external
Promise.

### Execution Host

`FolioHost` registers trusted artifacts, bindings and export allowlists. Its authenticated fetch
handler exposes ordered run, read, write and close operations with joined disposal and bounded
admission. `RemoteFolio` in `@gmitch215/folio/workers` is the client for it; [Workers](workers.md)
covers the client.

```ts
import { FolioHost } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

const token = process.env.FOLIO_TOKEN;

const host = new FolioHost({
  artifacts: {
    fixture: {
      program: readFileSync(new URL('../build/fixture.wasm', import.meta.url)),
      exports: ['program'],
      create: () => ({
        options: { memory: new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true }) }
      })
    }
  },
  authorize: (request) => request.headers.get('authorization') === `Bearer ${token}`
});

// mount host.fetch behind a service binding or an HTTP server
```

A client then opens a session on the artifact:

```ts
import { RemoteFolio } from '@gmitch215/folio/workers';

const endpoint = 'https://host.example/folio';
const token = process.env.FOLIO_TOKEN;
const inputBytes = new Uint8Array(4096);
const wordCount = 1024;
const rounds = 10_000;

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
backing, and trusted artifact factories enforce growth maxima and private-memory budgets. The host's
admission and transport bounds are in [Configuration](../configuration.md).

### Context Checkpoints

`InstanceCheckpoint` resets a private Wasm instance between independent jobs.
`prepareContext(bytes)` adds exports for every memory, mutable numeric global and table, and leaves
function bodies and start sections as they are. An `InstanceCheckpoint` copies that state once after
initialization. `restore()` compares each 64 KiB page with the copy, rewrites the pages that differ,
and puts back globals and table references. `restore('full')` copies every byte instead. Different
inputs may dirty different pages, so the checkpoint learns no page set from an earlier run.

```ts
import { InstanceCheckpoint, prepareContext } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

const bytes = readFileSync(new URL('../build/fixture.wasm', import.meta.url));
const plan = prepareContext(bytes);
const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
const instance = new WebAssembly.Instance(new WebAssembly.Module(plan.bytes as BufferSource), {
  env: { memory }
});
const mix = instance.exports.mix as (address: number, rounds: number) => number;

const checkpoint = new InstanceCheckpoint(instance, plan);

for (const rounds of [100, 5000, 7]) {
  mix(1024, rounds);
  checkpoint.restore();
}
```

A module that drops a passive data or element segment, uses Wasm GC objects, or holds a reference or
`v128` global cannot be restored through exports. `prepareContext` then keeps the original bytes and
lists the causes in `plan.reasons`, and `InstanceCheckpoint` throws so the caller creates a fresh
instance for each job. Memory or table growth throws `ContextResetError` before anything is written,
and the caller instantiates a new context. Host resources and the objects behind `externref` values
stay with the caller. `restore()` reads every page, so its cost follows the memory size and not the
number of changed pages.

A job that writes its whole input region before it runs can skip that region.
`restore('changed', ranges)` takes `{ offset, length }` ranges (and a `memory` index when the plan
has more than one) that it neither compares nor copies back, and `skippedBytes` in the report counts
them. The caller must write every byte of a range before the program reads it, because those bytes
keep the previous job's contents. Everything outside the ranges is restored as before, and an
invalid range throws a `RangeError` before anything changes. `examples/context-reset.ts` runs three
jobs on one instance and shows the growth error.

### How a Run Executes

Proved finite, nontrapping i32 kernels use runtime bounds and cross-region overlap checks, then run
native instructions against the shared allocation with no tracking or commit copy. A failed guard
falls back to tracked execution.

Tracked regions read a frozen shared base and keep private byte overlays. Once every reader stops,
Folio validates and commits in order. Conflicts replay against committed state, budgets discard
speculation, and ordered traps keep their preceding writes while later results are discarded.

The coordinator keeps admitted scalar control flow and live results. Inline numeric-memory spans
become regions when modified locals have no external live-outs and are assigned before reads on
every admitted path. Pure nonrecursive calls with unused results also qualify. Opaque functions,
recursion, host effects and state operations join preceding regions and run at their original owner.
Transactional memory covers i32, i64, f32 and f64 scalar operations plus `memory.copy` and
`memory.fill`, including unaligned access, overlap, NaN payloads, bounds and traps. Growth and
initialization stay at the coordinator. Unsupported instructions, reference and vector state,
memory64 and multiple memories keep native execution.

Shared source memory has zero-copy physical backing across the worker group. Ordinary source memory
keeps its original identity and buffer semantics, with an explicit shared snapshot per speculative
batch and ordered writeback, and the report counts the snapshot bytes. Regions travel in batches of
up to 16 per worker, and a singleton at a join runs locally.

Each isolate keeps its own stack, globals, table, JS heap and instance. Shared linear bytes do not
merge GC heaps or make arbitrary callbacks transferable. Give Folio exclusive access to its memories
and native exports until a run settles, and refresh views after shared growth. A failure during
direct native writes can leave partial memory, so the failed group closes and the application
restores a checkpoint before retrying. Instruction-defined traps keep their order and writes. Native
stack capacity and allocation failure can differ between isolates.

### Measuring a Module

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
static admission (`results/execution/admission/old-build-src.tar.gz`), alternating with the current
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
(native serial, native concurrent, Folio serial, Folio concurrent). Independent requests scale with
the number of instances whether or not Folio is involved, and the library adds nothing to that
result. `scripts/probe/php-regen.ts` regenerates a set of Drupal pages with private contexts pulling
from one queue and aborts if any page differs from the serial render. On ten cores it reproduced 31
pages 7.65x faster than one context. It also runs under Bun, which the task pool supports.

## Limits

- Accepted input does not guarantee a speedup. A true serial dependency runs serially, and a small
  job loses to dispatch overhead
  ([Architectural Boundaries](../../TECHNICAL_REPORT.md#architectural-boundaries)).
- Default admission dispatched no worker on any of 21 independent library kernels, and forcing
  admission made the 11 kernels that received regions slower than native
  ([Independent Corpus](../../TECHNICAL_REPORT.md#independent-corpus)).
- The iteration route on an unmodified outside program is measured on one loop shape: BLAKE3 reaches
  2.0x to 3.1x on the Ryzen machine, SHA-256 with a helper per input 1.7x to 2.1x, and LZ4 gains
  nothing ([The Iteration Route](../../TECHNICAL_REPORT.md#the-iteration-route)).
- The Node backend needs Node 26 or later. Async host imports and the managed backend need
  WebAssembly JSPI.
- The result equals the serial run for program memory and return values of a deterministic program.
  Stack-slot residue, thread identity, time, allocation addresses and memory growth during a run are
  outside that ([Correctness Boundary](../../TECHNICAL_REPORT.md)).

[Limits](../limits.md) groups every module's limits in one place.

## See Also

- API reference: [Folio](https://folio.gmitch215.dev/classes/index.Folio.html),
  [FolioHost](https://folio.gmitch215.dev/classes/index.FolioHost.html) and
  [InstanceCheckpoint](https://folio.gmitch215.dev/classes/index.InstanceCheckpoint.html).
- Report: [Mechanism and Correctness](../../TECHNICAL_REPORT.md#mechanism-and-correctness),
  [Execution Host and Portable Client](../../TECHNICAL_REPORT.md#execution-host-and-portable-client)
  and [Scope and Acceptance](../../TECHNICAL_REPORT.md#scope-and-acceptance).
- Studies: [Parallel Execution](../studies/parallel-execution.md).
- Next modules: [Pools](pools.md), [Folds and Certificates](folds-and-certificates.md),
  [Configuration](../configuration.md).
