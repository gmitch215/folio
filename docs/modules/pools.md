# Pools

The core finds independent work on its own where it can. A pool covers the programs that can say
which work is independent. The task pool runs named functions in private contexts on other threads.
The slice pool runs slices of a call range in place on one shared memory. The iteration route is the
pool Folio starts for a loop of calls without being asked. All three live in `@gmitch215/folio`.

## Overview

| Pool            | Who declares independence | Memory                           | Check on the result                    |
| --------------- | ------------------------- | -------------------------------- | -------------------------------------- |
| Task pool       | The caller, per task      | Each worker keeps its own state  | `audit` reruns every nth task serially |
| Slice pool      | The caller, per range     | One shared memory, no copy       | `audit: true` replays every slice      |
| Iteration route | Nobody, Folio validates   | One shared memory, private stack | Ordered validation with serial replay  |

Use the task pool for a batch of jobs that need no state from each other, such as rendering pages or
hashing files. Use the slice pool for a loop of records that a program keeps in one memory and
processes with one exported function. Use the iteration route through `Folio.run` when the loop is
already a countdown of calls and you want validation instead of a declaration.

A task pool of four workers over eight `sha256` jobs prints one digest prefix per job and the peak
number of tasks that ran at once. This is the output of `examples/task-pool.ts`:

```text
0 0acc41faaebdabb2
1 306622b22a81b598
2 cebad64b515a8e80
3 825b809f73cf6baf
4 114c7001c67f54de
5 f4f11c05bfbed520
6 536bdb483588a586
7 ce461247bb66e637
peak concurrency 3
```

The peak varies with scheduling. Results always arrive in submission order.

## Getting Started

The task pool owns one channel per worker. The caller starts each worker with `pool.link(index)` and
calls `serveTasks` there with a function that runs a named task. The owner submits jobs and joins
the results. This is `examples/task-pool.ts`, which runs the owner and the workers from one file:

```ts
import { TaskPool, peakConcurrency, serveTasks } from '@gmitch215/folio';
import { createHash } from 'node:crypto';
import { Worker, isMainThread, workerData } from 'node:worker_threads';

if (isMainThread) {
  const pool = new TaskPool(4);
  const workers: Worker[] = [];
  for (let index = 0; index < pool.size; index++) {
    const link = pool.link(index);
    workers.push(
      new Worker(new URL(import.meta.url), {
        workerData: { link },
        transferList: [link.port]
      })
    );
  }
  try {
    const chunks = Array.from({ length: 8 }, (_, index) => `chunk-${index}`.repeat(100_000));
    const results = await pool.run(chunks.map((chunk) => ['sha256', chunk] as [string, string]));
    results.forEach((result, index) => console.log(index, result.text().slice(0, 16)));
    const records = pool.drain();
    console.log('peak concurrency', peakConcurrency(records));
  } finally {
    pool.close();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
} else {
  serveTasks(workerData.link, (name, input) => {
    if (name !== 'sha256') throw new Error(`unknown task ${name}`);
    return createHash('sha256').update(input).digest('hex');
  });
}
```

`pool.run(jobs)` submits a list of `[name, input]` pairs and returns the results in submission
order. Each result has `text()`, `json()` and `bytes`. `pool.drain()` returns one record per joined
task, and `peakConcurrency(records)` counts how many ran at the same time. Run the file with
`node examples/task-pool.ts` on Node 26 or later.

## Intermediate

### Submitting and Joining

`submit(name, input)` returns a handle and the owner keeps going. `join(handle)` blocks until the
output arrives, and `joinAsync(handle)` waits without blocking the event loop. `runSync(jobs)` does
the same as `run` where the caller cannot yield, such as inside a synchronous Wasm import. Input and
output are strings or bytes. `submitJson` and `result.json()` cover structured values, and
`pool.width` limits how many workers take tasks.

Input on a `SharedArrayBuffer` is copied at submit, so a later write cannot reach the task.
`submit`, `run` and `runSync` take `{ share: true }` to post such an input as it is. That removes
the copy when the caller promises not to write those bytes until the task is joined.

```ts
import { TaskPool } from '@gmitch215/folio';
import { Worker } from 'node:worker_threads';

const pool = new TaskPool(4);
for (let index = 0; index < pool.size; index++) {
  const link = pool.link(index);
  new Worker(new URL('./task-worker.js', import.meta.url), {
    workerData: { link },
    transferList: [link.port]
  });
}

const shared = new Uint8Array(new SharedArrayBuffer(1 << 20));
// fill the input here, and leave it alone until the task is joined
const handle = pool.submit('render', shared, { share: true });
const result = await pool.joinAsync(handle);
console.log(result.text());
```

The worker side is the `serveTasks` call from the example above, in `task-worker.js`.

### Auditing Tasks

A worker shares nothing with the owner. Each task runs against that worker's own state, so a task
that reads or writes state the serial program would have shared returns a different result than the
serial run. `audit: { run, every }` runs every nth task again in the joining thread with `run` and
throws `TaskConflictError` with the first differing byte. The audit costs one serial execution per
checked task and suits tests and canaries.

```ts
import { TaskConflictError, TaskPool } from '@gmitch215/folio';

const pool = new TaskPool(4, {
  audit: {
    run: (name, input) => {
      // run the task called `name` on `input` in this thread and return its output
      return String(input);
    },
    every: 8
  }
});

try {
  const results = await pool.run([['render', 'page-1']]);
  console.log(results[0]?.text());
} catch (error) {
  if (error instanceof TaskConflictError) console.log(error.task, error.worker, error.offset);
  else throw error;
}
```

The pool does not discover independent work. Region discovery and ordered validation stay in the
core engine, and the task pool covers programs that can say which calls are independent. A task
function that throws fails with `TaskError`, which names the task and the worker.

### The Slice Pool

`SlicePool` runs an exported function over a range of calls on several threads, on one shared
memory, with no copy and no tracking. The caller declares that the calls are independent.
`SlicePool.open` compiles the module once, marks its imported memory shared, grows the memory by one
private stack per worker when the module keeps a stack pointer global, and starts the workers.
`run(entry, count, args)` splits `[0, count)` into slices, and `args(from, to)` returns the
arguments of the call for a slice. The records go into `pool.memory` after `open`, because opening
applies the module's data segments, and the results are read from it afterwards.

```ts
import { SlicePool } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

const bytes = readFileSync(new URL('../build/records.wasm', import.meta.url));
const count = 32;
const table = 1024;
const out = 2048;

const memory = new WebAssembly.Memory({ initial: 256, maximum: 4096, shared: true });
const pool = await SlicePool.open(bytes, { memory, workers: 4 });
try {
  // write the record table, the inputs and the output area into pool.memory here
  const report = await pool.run('digest_all', count, (from, to) => [
    table + 8 * from,
    to - from,
    out + 32 * from
  ]);
  console.log(report.slices, report.workers);
  const digests = new Uint8Array(pool.memory.buffer, out, count * 32);
} finally {
  await pool.close();
}
```

The module must import its memory with a declared maximum that leaves room for the stacks, and keep
at most one mutable global, which is taken to be the stack pointer. A start function, a dropped data
segment or a second mutable global refuses the module. Arguments and results are i32 or i64
(`bigint`). Imports other than the memory come from `imports`, a module specifier whose default
export returns them, because functions do not cross threads. `stackBytes` sets the private stack per
worker, 65,536 by default.

`run` takes `grain` (calls per slice; the default splits the range evenly over the workers) and
`audit`. It also takes `writes` and `snapshotLimit`, which only a pool opened with an ownership plan
needs (see [Folds and Certificates](folds-and-certificates.md)). The report holds `slices`,
`workers`, `wallMs`, the value each slice's last call returned in `results`, and whether the run was
`audited`.

Nothing here checks independence. A program that writes state the serial program would share returns
a different result. `run(..., { audit: true })` copies the memory before the run, runs the same
slices serially on the copy and compares every returned value and every byte below the stacks. It
throws `SliceConflictError` with the first difference. The audit costs a serial run and a memory
copy and suits tests and canaries. This is `examples/slice-pool.ts`, which fills one memory from
four threads and audits the run:

```ts
import { SlicePool } from '@gmitch215/folio';
import binaryen from 'binaryen';

const wasm = binaryen.parseText(`(module
  (import "env" "memory" (memory 1 8))
  (global $sp (mut i32) (i32.const 65536))
  (func (export "fill") (param $ptr i32) (param $len i32) (param $value i32) (result i32)
    (local $i i32)
    (block $done (loop $each
      (br_if $done (i32.ge_u (local.get $i) (local.get $len)))
      (i32.store8 (i32.add (local.get $ptr) (local.get $i)) (local.get $value))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $each)))
    (local.get $len)))`);
const compact = (binaryen.Features as unknown as { CompactImports: number }).CompactImports;
wasm.setFeatures(binaryen.Features.All & ~compact);
const bytes = Uint8Array.from(wasm.emitBinary());
wasm.dispose();

const memory = new WebAssembly.Memory({ initial: 1, maximum: 8, shared: true });
const pool = await SlicePool.open(bytes, { memory, workers: 4 });
try {
  const base = 4096;
  const count = 40_000;
  const report = await pool.run('fill', count, (from, to) => [base + from, to - from, 7], {
    audit: true
  });
  const filled = new Uint8Array(pool.memory.buffer, base, count).every((byte) => byte === 7);
  console.log({
    slices: report.slices,
    audited: report.audited,
    filled,
    stackBase: pool.stackBase
  });
} finally {
  await pool.close();
}
```

It prints `{ slices: 4, audited: true, filled: true, stackBase: 65536 }`.

A route that copies each task's records into a private context cannot win on a kernel whose speed is
the copy's bandwidth. The slice pool has no copy, and on a quiet Ryzen machine xxHash, Adler-32 and
LZ4 decompress over thousands of records ran 1.7x to 4.9x faster than serial on eight workers
([Architectural Boundaries](../../TECHNICAL_REPORT.md#architectural-boundaries)).

### The Iteration Route

A loop of calls that Folio recognizes needs no pool code. With a shared memory, `Folio.run` runs the
iterations on workers, validates them in order and replays any that conflict, and the report names
the route and the reason a loop stayed serial. The route's options (`iterationReadWindows`,
`iterationReadSummary`, `iterationSecondChance`, `iterationLogCeiling` and `iterationStall`) and a
runnable example are in the Loops of Calls section of [Core](core.md). BLAKE3 over several inputs
reaches 2.0x to 3.1x on the Ryzen machine through this route under default admission
([The Iteration Route](../../TECHNICAL_REPORT.md#the-iteration-route)).

## Limits

- The task pool and the slice pool check nothing unless asked. A wrong declaration returns a wrong
  result, and the audit finds it only on the tasks or slices it replays
  ([Correctness Boundary](../../TECHNICAL_REPORT.md)).
- The slice pool refuses modules with a start function, a dropped data segment or a second mutable
  global. Of 30 corpus drivers, 10 fail its output check because they share file-scope statics or
  allocator cursors
  ([Slice Pool, Admission Quality and Mixed Record Sizes](../../TECHNICAL_REPORT.md#slice-pool-admission-quality-and-mixed-record-sizes)).
- A task copies its records into the worker, so a kernel whose speed is the copy's bandwidth does
  not win on the task pool. The default copy took xxHash32 at 4,096 records to 0.22 of serial
  ([Architectural Boundaries](../../TECHNICAL_REPORT.md#architectural-boundaries)).
- Eighteen of 21 library kernels reach 2x or more on the task pool with learned-page reset. The
  eight-worker arm varies by up to 1.5x between runs
  ([Explicit Boundaries and Reset Policies](../../TECHNICAL_REPORT.md#explicit-boundaries-and-reset-policies)).
- The iteration route loses on loops whose iterations track expensively, and a loop that reads state
  another iteration is changing needs `iterationStall`
  ([Architectural Boundaries](../../TECHNICAL_REPORT.md#architectural-boundaries)).

[Limits](../limits.md) groups every module's limits in one place.

## See Also

- API reference: [TaskPool](https://folio.gmitch215.dev/classes/index.TaskPool.html) and
  [SlicePool](https://folio.gmitch215.dev/classes/index.SlicePool.html).
- Report: [Record-Level Corpus](../../TECHNICAL_REPORT.md#record-level-corpus),
  [Exact Chunked Recurrences](../../TECHNICAL_REPORT.md#exact-chunked-recurrences) and
  [The Iteration Route](../../TECHNICAL_REPORT.md#the-iteration-route).
- Studies: [Parallel Execution](../studies/parallel-execution.md).
- Next: [Folds and Certificates](folds-and-certificates.md) for exact folds over one stream and for
  certified record loops.
