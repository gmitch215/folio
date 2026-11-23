# Browser

## Overview

`@gmitch215/folio/browser` runs counted loops across dedicated module workers in Chromium and other hosts that have no JSPI. `BrowserFolio` takes a precompiled original module and the `loops`, `native`, `reasons` and `memories` metadata for it. `prepare` from `@gmitch215/folio` produces the first three offline. The caller writes the `memories` descriptor of the imported memory.

`BrowserFolio.open()` attaches the workers to the supplied shared `WebAssembly.Memory`. `run(name, args)` derives guarded partitions from one ordinary counted-loop call, proves their byte footprints in bounds and disjoint, dispatches them and joins before it returns. There is no snapshot, no transaction log, no JSPI and no per-load message. Other entries, and any call whose guards fail, run on the original instance. The workers need `SharedArrayBuffer`, which needs a cross-origin isolated page.

Use it when a page owns a large shared arena and a hot loop over independent records, and the page has no JSPI. A run that used the workers reports `native-shared`:

```text
native-shared 4 4
```

The fields are the mode, the workers that ran regions and the regions dispatched. A call that stayed on the owner reports `serial` and a `reason`.

## Getting Started

Prepare the program at build time. `prepare` needs `build/fixture.wasm`, which `bun run build:c` creates from `tests/c/fixture.c`.

```ts
import { prepare } from '@gmitch215/folio';
import { readFileSync, writeFileSync } from 'node:fs';

const bytes = readFileSync('./build/fixture.wasm');
const { loops, native, reasons } = prepare(bytes);
const memories = [
  { module: 'env', name: 'memory', initial: 2, maximum: 8192, shared: true, memory64: false }
];

writeFileSync('./public/program.json', JSON.stringify({ loops, native, reasons, memories }));
writeFileSync('./public/program.wasm', bytes);
```

The `memories` entry names the single imported memory of the module, with its limits as the module declares them. Serve both files from an origin that sets the cross-origin isolation headers, then open the pool in the page:

```ts
import { BrowserFolio, type BrowserProgram } from '@gmitch215/folio/browser';

const [bytes, metadata] = await Promise.all([
  fetch('/program.wasm').then((response) => response.arrayBuffer()),
  fetch('/program.json').then(
    (response) => response.json() as Promise<Omit<BrowserProgram, 'module'>>
  )
]);
const program: BrowserProgram = { ...metadata, module: await WebAssembly.compile(bytes) };
const memory = new WebAssembly.Memory({ initial: 4096, maximum: 8192, shared: true });

const folio = await BrowserFolio.open(program, { memory, workers: 4 });
try {
  new Uint32Array(memory.buffer, 65536, 67).fill(1);
  const report = await folio.run('program', [65536, 67, 65536]);
  console.log(report.mode, report.workers, report.regions);
} finally {
  await folio.close();
}
```

`program(address, count, rounds)` is a counted loop over `count` words. The library splits the 67 iterations into four regions, checks that the four byte ranges are disjoint, runs them on the four workers and returns when all have finished. The result equals the serial call.

The caller keeps exclusive ownership of the arena while `open` and `run` execute. A page must not write to the memory during a run.

## Intermediate

### Options

```ts
import { BrowserFolio, type BrowserProgram } from '@gmitch215/folio/browser';

declare const program: BrowserProgram;
declare const memory: WebAssembly.Memory;

const folio = await BrowserFolio.open(program, {
  memory,
  workers: 8,
  workerURL: '/lane.js',
  minimumParallelWork: 1_000_000
});
try {
  console.log(folio.inspect('program'));
  const report = await folio.run('program', [65536, 67, 65536]);
  if (report.mode === 'serial') console.log('ran at the owner:', report.reason);
  await folio.run('program', [65536, 67, 65536], { parallel: 'off' });
} finally {
  await folio.close();
}
```

`workers` is an integer from 1 through 32 and defaults to 4. A width of 1 attaches no workers. `workerURL` names the worker file. The default is `worker.js` beside the built `browser` module, so the published `dist/browser/worker.js` is part of the output. `minimumParallelWork` is the product of the count and the work parameters below which a call stays at the owner, 100,000 by default. `inspect(entry)` reports the mechanism (`counted-loop`), whether the entry has a loop plan and a native guard, and the number of attached workers.

A call stays at the owner with `serial` and one of these reasons:

- `requested` when `parallel` is `'off'`.
- `opaque-input` when an argument is not a number.
- `no-parallel-plan` when the entry has no loop plan or guard, or fewer than two workers attached.
- `single-region` when the count is below 2.
- `small-workload` when the work is under `minimumParallelWork`.
- `guard-failed` when the footprints could overlap, wrap or leave the memory.

A program is admitted to workers only when `reasons` is empty, the module has exactly one import and it is a shared 32-bit memory, and some entry has both a loop plan and a native guard. Any other module still opens, with every call running on the original instance. `folio.diagnostics` lists the preparation reasons.

### Handshake and Failure

Each worker attaches with a two-way atomic marker. `open` writes a marker to the first word of the memory, the worker instantiates the module on the same memory and swaps it, and `open` checks the swap before it restores the original word. A failed handshake throws and terminates the pool.

A worker failure after native writes joins the other workers, invalidates the pool and rejects the run. The library does not replay an arena that may hold partial writes. The application restores a checkpoint and opens a new pool. `close()` joins an active finite call before it terminates the workers. It does not promise to preempt a call that never ends.

### Node Callers

Node has no global `Worker`. A Node caller passes `workerFactory`, which returns an object with `postMessage`, `addEventListener`, `removeEventListener` and `terminate`. The unit test bridge in `tests/unit/browser/worker-bridge.ts` wraps a `worker_threads` worker in that shape and installs the lane protocol with `installBrowserWorker` from `src/browser/worker.ts`.

### Page Leases

The page directory is portable. `PageDirectory`, `MemoryPageOwner` and `ResidentPageLease` from `@gmitch215/folio/memory` import nothing from Node and compile no Wasm, so a page can hold them. `acquire({ read, write })` obtains bounded resident copies of pages, `lease.view(page)` returns a private view, and `commit()` publishes the written pages in one manifest decision. Leases work on copied bytes and the bundled owners keep their state in memory. [Memory](memory.md) covers the directory in full.

## Limits

- Only counted loops are extracted without JSPI. Arbitrary control-flow regions need explicit continuation lowering or a suspending coordinator. See [Browser Automatic Extraction Without JSPI](../../TECHNICAL_REPORT.md#browser-automatic-extraction-without-jspi).
- The measured speedups are wall time on one synthetic kernel. On a 268,435,456-byte allocation, the automatic call used 2, 4 and 8 workers and ran 1.929x, 3.063x and 3.449x faster than the native owner, with three samples per arm. They establish no aggregate CPU reduction, no energy saving and no consumer application speedup.
- A worker failure after native direct writes invalidates the pool. Recovery needs a checkpoint.
- There is no native aggregate CPU meter for browser workers. See [Browser Run](../../TECHNICAL_REPORT.md#browser-run).
- Shared memory needs a cross-origin isolated page. A page without `SharedArrayBuffer` runs every call on the original instance.
- Worker lanes accept scalar numeric arguments only.
- Browser JSPI is absent in the measured configuration, so a generalized controller needs a fallback or another configuration before it can use a shared arena.

[Limits](../limits.md) lists the limits that cross modules.

## See Also

- The API reference for `@gmitch215/folio/browser`, generated from `src/browser.ts`.
- [Memory](memory.md) for page directories and leases.
- [Workers](workers.md) for the managed backend, which uses JSPI in its owner.
- [Browser Automatic Extraction Without JSPI](../../TECHNICAL_REPORT.md#browser-automatic-extraction-without-jspi) and [Browser Run](../../TECHNICAL_REPORT.md#browser-run) in the technical report.
- [Parallel Execution](../studies/parallel-execution.md) for the scaling studies.
