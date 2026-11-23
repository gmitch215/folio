# Continuation

## Overview

`@gmitch215/folio/continuation` runs a Wasm guest across Durable Object alarm events. Each event gets its own CPU budget, and the platform ends an event that runs past it. A guest that needs more CPU than one event allows stops at a clean point, keeps its state and resumes in a later event.

The model has four parts.

- Planned stop. The guest returns from its `run` function at a point it chose, a quiescent point where its state lives entirely in linear memory, its mutable globals and a small host state record. The host runs the guest for a step budget.
- Commit. When the budget runs out, the event commits the pages that changed, the mutable globals and the host state record to the object's SQLite storage, then arms the next alarm. Every event that stops on its budget commits before it returns.
- Signal. The platform raises a CPU warning before the budget ends. The warning is a u32 word in the guest's memory, whose address the guest exports as the i32 global `__instance_signal`. A guest that polls the word returns early. That event stops without a commit. The next event commits before it runs the guest.
- Restore. If the isolate changed between events, the next event restores the last commit first.

An unplanned loss is a reset the platform causes. The design limits its cost to the work since the last commit. A suspended JSPI stack does not survive an isolate change, so a guest resumes from a quiescent point and never from a suspended call.

The entry exports `runSlice`, `cpuSignal`, `saveCheckpoint`, `loadCheckpoint`, the two checkpoint stores `sqlCheckpointStore` and `memoryCheckpointStore`, `hashPages`, `changedPages` and `CheckpointError`. Use it for a job that needs more CPU than one event allows and whose state a guest keeps in linear memory. `runSlice` returns the outcome of each event. Four events of the guest in `tests/c/continuation.c`, each in a new instance over an in-memory SQLite stand-in for the storage, return:

```text
{ finished: false, restored: false, stop: 'budget', epoch: 1, budget: 4000 }
{ finished: false, restored: true, stop: 'budget', epoch: 2, budget: 8000 }
{ finished: false, restored: true, stop: 'budget', epoch: 3, budget: 16000 }
{ finished: false, restored: true, stop: 'budget', epoch: 4, budget: 32000 }
```

## Getting Started

A guest needs three things. It has a `WebAssembly.Memory`. It has a `run(budget)` function that runs up to `budget` steps and returns at a quiescent point, with a nonzero value when the job is finished. It has a step counter that only increases. The names belong to the caller, because `runSlice` takes callbacks. A guest that wants the early stop polls the `__instance_signal` word in its loops and returns when the word is nonzero. `tests/c/continuation.c` is a small C guest that does this.

```ts no-check
import { cpuSignal, runSlice } from '@gmitch215/folio/continuation';
import { DurableObject } from 'cloudflare:workers';
import guest from './guest.wasm';

export class Job extends DurableObject {
  #instance?: WebAssembly.Instance;

  async start(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + 5000);
  }

  override async alarm(): Promise<void> {
    const instance = (this.#instance ??= new WebAssembly.Instance(guest));
    const memory = instance.exports.memory as WebAssembly.Memory;
    const run = instance.exports.run as (budget: number) => number;
    const steps = instance.exports.get_steps as () => number;
    const signal = cpuSignal(instance, memory);

    const result = await runSlice({
      storage: this.ctx.storage,
      memory,
      signal,
      run(budget) {
        if (run(budget)) return 'finished';
        return signal?.raised ? 'signal' : 'budget';
      },
      steps
    });
    if (result.lost) console.log('retrying with budget', result.lost.to);
    if (result.finished) console.log('done after epoch', result.epoch);
  }
}
```

`runSlice` is called from `alarm()`. It clears the signal word, restores the last checkpoint when this is a new isolate, runs the guest with the event budget and commits at a budget stop. It re-arms the alarm unless the job finished. `cpuSignal(instance, memory)` returns `undefined` for a guest that does not export `__instance_signal`, and `signal` is then optional in `runSlice`.

`start()` sets the first alarm 5 s ahead. The start of a chain is a request path. On bare objects running events of about 0.25 s of CPU, an alarm 1 ms to 1 s ahead reset 13 to 16 of 20 first events, against 0 of 20 at 5 s and 60 s. The result is in the Retirement and Alarm Shape paragraph of [Storage Resets and the Growth Governor](../../TECHNICAL_REPORT.md#storage-resets-and-the-growth-governor).

The [continuation example](https://github.com/gmitch215/folio/blob/master/examples/continuation.ts) is the same object with a `fetch` handler that starts the chain, and `tests/integration/memory/continuation.test.ts` runs a longer one on a local workerd and compares its final memory with an uninterrupted run.

## Intermediate

### Event Budget

`runSlice` gives each event a step budget. The first event runs `initialBudget` steps, 2,000 by default. Before the first signal stop, each committed budget stop doubles the budget. After a signal stop in which the guest ran `s` steps, the budget becomes the larger of `initialBudget` and `0.7 s`. After each later committed budget stop it grows by 2%. Each commit saves the budget and the step count in a state envelope, so a restore after an isolate change brings the budget back. A signal stop writes nothing. If the object moves before the next commit, the new budget is lost, and the next signal re-measures it at the cost of one event. See [Event Budget](../../TECHNICAL_REPORT.md#event-budget).

### Loss Detection

An event that runs past its CPU limit is killed before it can commit, and a retry at the same budget would be killed again. `runSlice` records each attempt. It writes an attempt row with the event number and budget and flushes it with `storage.sync()` before the guest runs. An event that starts in a new isolate and finds an open attempt with no commit after it knows the previous attempt was killed. It halves that budget, never below `initialBudget`, stops doubling and returns the halving as `lost`.

```ts
import { runSlice, type SliceOptions } from '@gmitch215/folio/continuation';

declare const options: SliceOptions;

const result = await runSlice(options);
if (result.lost) {
  console.log(`event ${result.lost.k} died at ${result.lost.from}, retrying at ${result.lost.to}`);
}
```

At most `log2(b / B0)` kills occur before an event fits, where `b` is the killed budget and `B0` the initial one, unless a single stretch of guest code that cannot park is longer than one event. A kill that lands before the flush returns leaves no row, and that event retries at the same budget. A signal stop or a cut closes the attempt after it re-arms. The checkpoint stores take a `flush` for this: `sqlCheckpointStore(sql, { sync: () => storage.sync() })` provides it, and `runSlice` builds its own store that way. Without the flush a killed invocation discarded the marker in a deployed run, and the rule never fired. See [PHP Park](../../TECHNICAL_REPORT.md#php-park).

### Host State and Globals

A guest whose state includes mutable globals lists them in `globals`, as `WebAssembly.Global` objects by name. Each commit stores their values, and a restore writes them back. A checkpoint whose recorded globals differ from the list is refused with `CheckpointError` code `global`. State that lives in JavaScript goes through `state` and `restore`. `state()` returns a string saved with each commit, and `restore(state)` runs after a restore and before the guest.

```ts no-check
import { cpuSignal, runSlice } from '@gmitch215/folio/continuation';
import { DurableObject } from 'cloudflare:workers';
import guest from './guest.wasm';

export class Job extends DurableObject {
  #instance?: WebAssembly.Instance;
  #log: string[] = [];

  override async alarm(): Promise<void> {
    const instance = (this.#instance ??= new WebAssembly.Instance(guest));
    const memory = instance.exports.memory as WebAssembly.Memory;
    const run = instance.exports.run as (budget: number) => number;
    const steps = instance.exports.get_steps as () => number;
    const signal = cpuSignal(instance, memory);

    await runSlice({
      storage: this.ctx.storage,
      memory,
      signal,
      globals: { stack: instance.exports.stack as WebAssembly.Global },
      initialBudget: 5000,
      state: () => JSON.stringify(this.#log),
      restore: (state) => {
        this.#log = state ? (JSON.parse(state) as string[]) : [];
      },
      run(budget) {
        if (run(budget)) return 'finished';
        return signal?.raised ? 'signal' : 'budget';
      },
      steps
    });
  }
}
```

A guest that performs effects keeps its own log, because the module does not log imports. Pure compute replays for free. A write to the object's own SQLite happens once when the guest logs each import result in the same synchronous span as the write it reports. An external effect happens at least once, and an idempotency key derived from the job, the checkpoint epoch and the sequence makes it safe when the far side honours the key. No study measures these three classes.

### Checkpoint Stores

`saveCheckpoint(store, memory, options)` hashes every 64 KiB page, compares the hashes with the last manifest and writes only the pages that changed, with the globals and the host state. `loadCheckpoint(store, memory, { globals })` verifies every page against its hash before it writes any page into memory, grows the memory to the checkpoint's size and returns the epoch and the saved state. A failed check throws `CheckpointError` with code `hash`, `size`, `global` or `manifest`. `memoryCheckpointStore()` is the in-process store for tests and Node, and `sqlCheckpointStore(sql, { groupPages, prefix, sync })` keeps one row per group of pages in Durable Object SQLite, 16 pages or 1 MiB by default. Keep one `groupPages` per prefix, and run a commit in one synchronous span.

```ts
import {
  CheckpointError,
  loadCheckpoint,
  memoryCheckpointStore,
  saveCheckpoint
} from '@gmitch215/folio/continuation';
import { readFileSync } from 'node:fs';

const module = new WebAssembly.Module(Uint8Array.from(readFileSync('./build/continuation.wasm')));
const first = new WebAssembly.Instance(module);
const run = first.exports.run as (budget: number) => number;
const memory = first.exports.memory as WebAssembly.Memory;

const store = memoryCheckpointStore();
run(50);
console.log(saveCheckpoint(store, memory, { stateJson: { note: 'after 50' } }));
run(50);
console.log(saveCheckpoint(store, memory));

const second = new WebAssembly.Instance(module);
try {
  const restored = loadCheckpoint(store, second.exports.memory as WebAssembly.Memory);
  console.log(restored?.epoch, (second.exports.get_steps as () => number)());
} catch (error) {
  if (error instanceof CheckpointError) console.log(error.code);
}
```

`saveCheckpoint` returns `{ epoch, pagesWritten, bytesWritten }`. The second save writes fewer pages than the first, because only the changed pages go out. The hash pass costs a read of the whole memory at every checkpoint, since linear memory has no write barrier. `hashPages` is pure JavaScript, so it runs wherever the module does. A deployed object took 7.3 ms for a checkpoint with no change, 23.7 ms with 4 MiB changed and 78 ms with 16 MiB changed. See [Claims](../../TECHNICAL_REPORT.md#claims).

### PHP Guests

PHP is the first guest measured with this module. It needs a build with the interrupt-park patch. The patch places a poll at the interrupt check of the interpreter loop. A park saves the current execute data and opline, then jumps back to the host. A resume re-enters the interpreter with the saved execute data at the saved opline. The Zend VM keeps its frames on the heap, so a jump out of the interpreter loop keeps every live value in linear memory, and a parked state is a quiescent point.

A poll inside a region that cannot park is refused, and the next admissible poll is tried. In the study workload two regions were refused, an `array_map` with a closure and a generator body, and the park landed at the first admissible poll inside the generator loop. The paired poll cost on a Linux x86-64 machine was a median ratio of 1.018 for `fib(35)` and 1.020 for a string-array workload. The repository drives such a build with `experiments/continuation-php`, which takes the interpreter module from a directory the caller names.

On paid Durable Objects a PHP guest of 96 to 115 MiB stopped on a step budget that started at 10 million polls and doubled at each commit until the first signal. A commit preceded every event's return. After the checkpoint streamed one page group at a time and loss detection was in place, one object finished with the same output SHA-256 as the uninterrupted local run, with one exact restore and one alarm kill paired with one `lost` record. Three objects then ran the same code at once and all finished with the same output hash. See [PHP Park](../../TECHNICAL_REPORT.md#php-park) and [Continuation Across Events](../studies/continuation-across-events.md).

## Limits

- A loop with no poll and no import can only be killed. Wasm has no asynchronous interrupt except termination, so a guest needs a poll on every loop not proved short (B1). See [Boundaries](../../TECHNICAL_REPORT.md#boundaries).
- No event exceeds its budget only if the largest CPU between two polls plus the cost of stopping is below the lead the platform gives before the budget ends. The lead is not measured, so this is a condition the design depends on and no measured guarantee. In the signal study 10 of 30 events reset before returning, and 20 returned with the signal fired in each. See [Platform Facts](../../TECHNICAL_REPORT.md#platform-facts) and [Claims](../../TECHNICAL_REPORT.md#claims).
- The signal timing is platform policy and can change (B3). If the warning stopped arriving, the fallback is a wall-clock bound, which stops compute-bound slices early.
- A write left pending while a guest runs synchronously for about 30 s resets the object. `runSlice` awaits its attempt row before it runs the guest. The report attributes the 10 first-event resets of the signal study to a pending write by contrast with the durable chain study. That comparison spans two studies and is not a controlled arm.
- Design rule for a marker written before an effect: writes are durable once an await or flush has passed them. On bare objects, a marker followed by an awaited yield survived every reset kind tested, and a marker followed directly by the effect can be lost with the effect repeated. `await storage.sync()` before a CPU kill kept two earlier plain writes in 10 of 10 objects, with or without a later yield. See [Storage Resets and the Growth Governor](../../TECHNICAL_REPORT.md#storage-resets-and-the-growth-governor) and [Storage Resets](../studies/storage-resets.md).
- The hash pass is a read of the whole memory at every checkpoint (B4). In paired Node 26 runs on one machine `hashPages` had a median of 1.26 GiB/s on 32 MiB and 1.01 GiB/s on 128 MiB. The 128 MiB runs split between about 1 and about 0.25 GiB/s, and the cause is not measured.
- Alarm handlers have a wall-clock limit, and a slice that waits on I/O reaches it as well as the CPU budget (B5). An inbound client connection cannot move to a new isolate (B6).
- The platform replaces isolates between events and a deploy can reset a running object in the middle of an event. Work since the last commit is lost, which is at most one event's budget (B7, B8). No study measures a deploy reset.
- A refused stretch of PHP that is longer than one event's CPU never reaches an admissible poll inside that event and does not complete (B9). The design predicts that each event restarts the region from the last commit, and that replay was not measured.
- The deployed PHP runs are four objects with one workload. They show recovery from one kill per object and not from repeated kills, and no signal park occurred. The tail CPU sum exceeds the platform's GraphQL CPU figure by a wide margin in every deployed run, and the cause is not resolved.
- The cost of a commit at every budget stop is a model. With the inputs measured so far it is 1.088 to 1.149% per event at 18 events between signal stops, and an upper bound, because the mean CPU between moves is known only as a lower bound of 261.2 s. See [Claims](../../TECHNICAL_REPORT.md#claims).
- The poll cost for a generic C guest has no study, and the local poll cost in the checkpoint study is not resolved.

[Limits](../limits.md) lists the limits that cross modules.

## See Also

- The API reference for `@gmitch215/folio/continuation`, generated from `src/continuation.ts`.
- [Memory](memory.md) for the other storage-backed memory tools, and [Boot](boot.md) for starting a guest from an image.
- [Continuation Across Invocations](../../TECHNICAL_REPORT.md#continuation-across-invocations) in the technical report, with the claims C1 to C9, the boundaries B1 to B9 and the proofs.
- [Continuation Across Events](../studies/continuation-across-events.md) and [Storage Resets](../studies/storage-resets.md) for the studies and deployed runs.
