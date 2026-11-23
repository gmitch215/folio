# Advanced Usage

This page covers the combinations the module pages leave out: a job that outlasts one Durable Object event, a PHP application host, a Linux userland, memory larger than one isolate, pools used together, resets and bounds on a guest, and how to read the evidence. Each section gives what the feature is, when to use it, the smallest working code and its limit. The basics of each module are in [Modules](docs/modules/README.md), and every figure comes from [the technical report](TECHNICAL_REPORT.md) or a study under [results](https://github.com/gmitch215/folio/blob/master/results/README.md).

The limits that apply to every route are in [Limits](docs/limits.md). The measurement behind each section has a page under [Studies](docs/studies/README.md).

## Long Jobs on Durable Objects

A Wasm guest that needs more CPU than one alarm event allows runs as a chain of events. `runSlice` restores the last checkpoint, runs the guest for a step budget, commits a checkpoint at a budget stop and re-arms the alarm. A guest that exports `__instance_signal` also stops when the platform warns that the event's CPU is nearly spent.

Use it for a deterministic guest that has quiescent points, where its state lives entirely in linear memory, its mutable globals and a small host record. Three parts go together. A baked boot image gives each new isolate an initialized guest without running the boot again. `governGrowth` caps linear memory so an oversized request fails inside the guest. The checkpoint store is the SQLite store `runSlice` opens over the object's own storage.

Bake the image at build time. The guest's own boot function runs once, and the pages it changed become data segments of a new module.

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { bakeModule, captureImage } from '@gmitch215/folio/boot';

const bytes = new Uint8Array(readFileSync('build/guest.wasm'));
const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes as BufferSource));
const memory = instance.exports.memory as WebAssembly.Memory;

// keep a copy of the fresh memory, run the guest's own boot, then keep the pages that changed
const fresh = new Uint8Array(memory.buffer).slice();
(instance.exports.boot as () => void)();
const image = captureImage(memory, fresh);

writeFileSync('build/guest-baked.wasm', await bakeModule(bytes, image));
console.log('changed pages', image.pages);
```

The object binds the baked module, caps its memory and runs one slice per alarm.

```ts
import {
  cpuSignal,
  type DurableObjectStorage,
  runSlice,
  type StopReason
} from '@gmitch215/folio/continuation';
import { governGrowth } from '@gmitch215/folio/memory';

// wrangler binding: wasm_modules = { GUEST = "build/guest-baked.wasm" }
interface Env {
  GUEST: WebAssembly.Module;
}

// size this from the boot size and peak of your own guest; it caps linear memory only
const CAP_BYTES = 100 * 1024 * 1024;

export class LongJob {
  private readonly storage: DurableObjectStorage;
  private readonly env: Env;
  private instance: WebAssembly.Instance | undefined;

  constructor(ctx: { storage: DurableObjectStorage }, env: Env) {
    this.storage = ctx.storage;
    this.env = env;
  }

  async fetch(): Promise<Response> {
    this.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS job (id INTEGER PRIMARY KEY, input TEXT NOT NULL)'
    );
    this.storage.sql.exec("INSERT OR REPLACE INTO job (id, input) VALUES (1, 'input')");
    // a request path keeps the alarm at least 5 s ahead
    await this.storage.setAlarm(Date.now() + 5000);
    return new Response('started');
  }

  async alarm(): Promise<void> {
    let instance = this.instance;
    if (!instance) {
      instance = new WebAssembly.Instance(this.env.GUEST);
      governGrowth(instance.exports.memory as WebAssembly.Memory, { capBytes: CAP_BYTES });
      this.instance = instance;
    }
    const memory = instance.exports.memory as WebAssembly.Memory;
    const run = instance.exports.run as (budget: number) => number;
    const steps = instance.exports.get_steps as () => number;
    const signal = cpuSignal(instance, memory);

    const outcome = await runSlice({
      storage: this.storage,
      memory,
      signal,
      run(budget): StopReason {
        if (run(budget)) return 'finished';
        return signal?.raised ? 'signal' : 'budget';
      },
      steps
    });
    if (outcome.lost) console.warn('previous attempt was killed', outcome.lost);
    if (outcome.finished) console.log('finished at epoch', outcome.epoch);
  }
}
```

The names `run`, `get_steps` and `boot` belong to the guest. [examples/continuation.ts](https://github.com/gmitch215/folio/blob/master/examples/continuation.ts) runs the same shape against `tests/c/continuation.c`.

### Sizing the Budget

`runSlice` starts a guest at `initialBudget` steps, 2,000 by default. Each committed budget stop doubles the budget until the first signal stop. After a signal stop in which the guest ran `s` steps, the budget becomes the larger of the starting budget and `0.7 s`, and each later committed stop adds 2%. Each commit saves the budget, so a restore in a new isolate brings it back. A signal stop writes nothing, so a move before the next commit loses the measured budget and the next signal measures it again at the cost of one event.

The number of events for a job of `J` CPU-seconds follows from the budget `B`, the lead `L` of the platform's warning and the cost `c_y` of stopping:

```math
N = \left\lceil \frac{J}{B - L - c_y} \right\rceil
```

The lead is not measured, so `N` is a model. Events that stopped on the signal ended between 29.998 s and 32.476 s of CPU on deployed objects, and a checkpoint of a deployed object took 7.3 ms with no change, 23.7 ms with 4 MiB changed and 78 ms with 16 MiB changed ([durable-chain](https://github.com/gmitch215/folio/blob/master/results/continuation/durable-chain/README.md)). With commits at every budget stop, the model puts the cost at 1.088 to 1.149% per event over a cycle of 18 events, against 12.83 to 12.89% for a protocol that only stops on the signal ([Claims](TECHNICAL_REPORT.md#claims)).

### When an Event Is Killed

A killed event leaves no commit, so the next event would start from the same budget and die the same way. Before the guest runs, `runSlice` writes an attempt row with the event number and the budget, then flushes it with `storage.sync()`. An event that starts in a new isolate and finds an open attempt with no commit after it knows the previous attempt died. It halves that budget, never below `initialBudget`, stops doubling and returns the halving in `lost`. At most `log2(b / B0)` kills happen before an event fits, unless one refused stretch of the guest is longer than an event. Without the flush, a killed invocation discarded the marker and the rule never fired in a deployed run.

### Commit Before the Guest Runs

A write left pending while a guest runs synchronously for about 30 s resets the object. Make every write the job needs before `runSlice`. It flushes with `storage.sync()` after it writes the attempt row and before it runs the guest, so earlier writes of the same alarm are durable by then. A write made inside `run`, or after `runSlice` returns, stays pending while the guest runs.

The evidence for this rule is a comparison between two studies. The signal study left a slice write unawaited and 10 of its 30 events reset before returning, all of them the first event of their object. The durable chain study awaited its bookkeeping writes first and none of its 30 events reset. The two used different guests, so the pending write is a candidate explanation and not a tested one ([signal](https://github.com/gmitch215/folio/blob/master/results/continuation/signal/README.md), [durable-chain](https://github.com/gmitch215/folio/blob/master/results/continuation/durable-chain/README.md)).

**Limit.** The no-termination guarantee depends on the platform's warning arriving early enough, and the warning arrived in 20 of 30 events of the signal study. A guest needs a poll on every loop that is not proved short, and a suspended JSPI stack does not survive an isolate change ([Boundaries](TECHNICAL_REPORT.md#boundaries)). `governGrowth` guards linear memory and does not bound the JavaScript-side charge. The module pages are [Continuation](docs/modules/continuation.md), [Boot](docs/modules/boot.md) and [Memory](docs/modules/memory.md).

## A PHP Application Host

A PHP application such as Drupal runs on Durable Objects as a Wasm interpreter that the host drives through the same continuation, boot image and governor as any other guest. Four pieces apply: a PHP build that can park, a baked image of the booted interpreter, a cap on linear memory and an alarm that stays away from the request path.

Use it when a request or job outlasts one event, or when the cost of a cold start dominates. It does not make one request faster.

### Parking an Interpreter

The park build patches the interrupt check of the Zend interpreter loop. A poll there saves the current execute data and opline, jumps back to the host and later resumes the same activation. The park is exact when every frame on the chain is user code and exactly one frame, the outermost, was entered from C. A poll that fails this test is refused and the next admissible poll is tried. An `array_map` with a closure and a generator body are refused stretches.

A refused stretch delays the park until the next admissible poll. The interpreter retries at every poll, because a fixed retry period aliases with a loop whose iteration holds a number of polls that divides the period, and such a loop would never reach an admissible poll. A refused stretch longer than one event's CPU never reaches an admissible poll inside that event, so it restarts from the last commit at every event. That replay is stated from the design and was not measured. The poll costs about 1.8% on `fib(35)` and 2.0% on a string-array workload, and its cost on a 60 million iteration loop is not resolved ([php-poll-cost](https://github.com/gmitch215/folio/blob/master/results/continuation/php-poll-cost/README.md)).

The deployed runs used a guest of 96 to 115 MiB. A checkpoint that copied the whole memory twice put an event over the memory limit at its sixth event, so the checkpoint streams one page group at a time. The step budget starts at 10 million polls and doubles at each commit until the first signal, and a doubled budget of 320 million polls overran the CPU limit before any park. Loss detection fixed that: one kill per object paired with one `lost` record, the budget fell to 160 million polls, and all three objects of the second run finished with the output hash of the uninterrupted local run. No object took a signal park, and the per-event records are not exported to `results/`.

### Alarms and Images

A request path moves the alarm at least 5 s ahead. On three deployed runs of 300 requests per arm, the floor read 5 of 900 requests retried after a storage reset (0.56%) against 114 of 900 without it (12.7%). It does not reach zero, and the cause of the remainder is open. Committing with `storage.sync()` before an alarm moves earlier did worse in a deployed A/B: 11 of 150 requests reset against 1 of 150 for the old path.

A baked image holds the heap of the process that made it, so anything the heap held is public with the module. Bake from throwaway key and salt values, put the real values in on replay, and search the image before it ships. The host sets a new PHP session identifier at the start of every request, because the bake request's identifier stays in the image.

```ts
import { decodeImage, findInImage } from '@gmitch215/folio/boot';
import type { DurableObjectStorage } from '@gmitch215/folio/continuation';
import { readFileSync } from 'node:fs';

// a request path moves the alarm at least 5 s ahead
const FLOOR_MS = 5000;

export async function armFromRequest(storage: DurableObjectStorage, delayMs: number) {
  await storage.setAlarm(Date.now() + Math.max(delayMs, FLOOR_MS));
}

// before shipping a baked image, search it for the values the live site holds
declare const realSalt: string;

const image = decodeImage(new Uint8Array(readFileSync('build/php-after-render.image')));
const found = findInImage(image, [new TextEncoder().encode(realSalt)]);
if (found.length) throw new Error('the image holds a real secret; bake from throwaway values');
```

On a Durable Object Drupal host, the after-render image delivered as static assets cut the first request of a fresh site that matches the pack by 60% to 72% of cpuTime (n=5 per run, two runs), and the serve path after a drop by 44% (555 ms against 989 ms, n=4 per arm). A site whose configuration differs boots plain ([Baked Boot Images](TECHNICAL_REPORT.md#baked-boot-images)).

### What Parallelism Does Here

Independent work on private contexts scales and one render does not. Regenerating 31 pages on ten private contexts read 7.65x at the median (n=20, process CPU 1.087x), and eight concurrent renders read 7.06x ([Independent PHP Requests and the Drupal Render Breakdown](TECHNICAL_REPORT.md#independent-php-requests-and-the-drupal-render-breakdown)). One uncached Drupal render under automatic extraction read 0.87x to 1.02x with no worker dispatched, because about 90% of it is PHP execution on one thread. The block build and placeholder share of the cold stock render bound a gain near 1.15x from launching blocks early, and no prototype exists ([Work Inside One PHP Request](TECHNICAL_REPORT.md#work-inside-one-php-request)).

**Limit.** The deployed continuation runs are four objects with one workload and recovered from one kill each, so recovery from repeated kills is not shown. A baked image serves only a site whose pack generation, module set, driver and configuration rows equal the bake's. The Thunder admin and flush routes still get killed above the platform's memory line, and no deployed fix completes them ([A Drupal Distribution on Durable Objects](TECHNICAL_REPORT.md#a-drupal-distribution-on-durable-objects)).

## A Linux Userland on WebAssembly

A Linux userland compiled to Wasm keeps its mappings, protection, file descriptors and scheduling inside the machine. Folio supplies the pieces around it: continuation for a process that outlasts an event, elastic regions for state larger than one isolate, and the page directory and leases of `@gmitch215/folio/memory`. The machine takes no dependency on Folio and Folio takes none on the machine.

Use these when the machine's processes are independent and long. The boundary between a process and its state is a copy: a lease copies a span into the guest's memory before a slice, and the host writes it back before the lease is released.

```ts
import type { ElasticRegion } from '@gmitch215/folio/memory';

const PAGE = 65536;

// copy pages of a process image from the region into the guest before its slice
export function lend(
  region: ElasticRegion,
  memory: WebAssembly.Memory,
  pointer: number,
  page: number,
  pages: number
): void {
  region.copyIntoMemory(memory, pointer, page * PAGE, pages * PAGE);
}

// write the span back and flush it to the holder before the lease ends
export function giveBack(
  region: ElasticRegion,
  memory: WebAssembly.Memory,
  pointer: number,
  page: number,
  pages: number
): void {
  region.copyFromMemory(memory, pointer, page * PAGE, pages * PAGE);
  region.flush();
}
```

The report records what crossing an isolate costs, and the figures set which designs can work.

| Boundary                           | Measured                                                                                 | Source                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Call from one object to a peer     | median 7 ms over RPC, 10 ms over `fetch`, 3 ms to an object's own stub; first call 18 ms | [platform-ladder](https://github.com/gmitch215/folio/blob/master/results/execution/platform-ladder/README.md)                  |
| Stub calls in one invocation       | 1,000 succeed and the 1,001st fails                                                      | [platform-ladder](https://github.com/gmitch215/folio/blob/master/results/execution/platform-ladder/README.md)                  |
| Write to a Durable Object's SQLite | 1.53 to 5.26 ms net per write, by value size and shape                                   | [platform-ladder](https://github.com/gmitch215/folio/blob/master/results/execution/platform-ladder/README.md)                  |
| One page operation, remote owners  | 25.5 ms per operation, with no executor cache                                            | [managed-envelope](https://github.com/gmitch215/folio/blob/master/results/execution/elastic-memory/managed-envelope/README.md) |
| One record dispatched to a lane    | 17 to 29 times the serial time with run-encoded sets                                     | [Managed Corpus Transfer](TECHNICAL_REPORT.md#managed-corpus-transfer)                                                         |
| A call of about 34 ns              | `Folio.run` adds about 0.65 us, so the machine core ready queue reads 0.052x per call    | [Static Admission and the Native Fallback](TECHNICAL_REPORT.md#static-admission-and-the-native-fallback)                       |

All platform rows are one account, one colo and one day. A process that issues many small calls to another isolate pays the hop on every one, so the unit that crosses should be a span of pages, a whole record batch or a whole process slice.

**Limit.** No Linux boot, process main, syscall test or speedup measurement has run. A process artifact's three libc calls match native in every byte, and the machine core ready queue runs serially. The page directory and its leases are local protocol evidence with copied pages: no crash recovery, no durable owners, and no coherence for shared writable mappings or futexes ([Distributed Page Ownership and Writeback](TECHNICAL_REPORT.md#distributed-page-ownership-and-writeback), [Machine-Core Coverage and the Process Boundary](TECHNICAL_REPORT.md#machine-core-coverage-and-the-process-boundary)).

## Memory Larger Than One Isolate

An `ElasticRegion` presents a logical byte range of any whole number of chunks and keeps only a window of chunks in one buffer. A read or write that misses faults the chunk in from a holder and, when the window is full, evicts the least recently used unpinned chunk and writes it back if it is dirty. The sync form takes a `SyncHolder`, the async form an `AsyncHolder`.

Use it for data a Wasm guest or host code addresses by offset when the whole range would not fit under the platform's memory line. `chunkBytes` is a power of two from 4 KiB to 8 MiB, and `frames` is the number of resident chunks. The window is one `ArrayBuffer` of `frames * chunkBytes`.

```ts
import {
  ElasticRegion,
  peerHolder,
  sqlHolder,
  StaleChunkError,
  type PeerStub
} from '@gmitch215/folio/memory';

interface Storage {
  sql: {
    exec(
      query: string,
      ...bindings: (string | number | null | ArrayBuffer)[]
    ): { toArray(): Record<string, unknown>[] };
  };
}

const MIB = 1024 * 1024;

// 256 MiB of logical bytes held in 1 MiB chunks, 32 of them resident at a time
export function openRegion(storage: Storage): ElasticRegion {
  const region = new ElasticRegion({
    byteLength: 256 * MIB,
    chunkBytes: MIB,
    frames: 32,
    holder: sqlHolder(storage.sql, 'heap_chunks', 'heap')
  });

  // the version table lives in the instance, so a new isolate restores it from a saved copy
  storage.sql.exec(
    'CREATE TABLE IF NOT EXISTS heap_table (id INTEGER PRIMARY KEY, bytes BLOB NOT NULL)'
  );
  const saved = storage.sql.exec('SELECT bytes FROM heap_table WHERE id = 1').toArray()[0];
  if (saved) region.restoreTable(new Uint32Array(saved.bytes as ArrayBuffer));
  return region;
}

export function saveRegion(storage: Storage, region: ElasticRegion): void {
  // write dirty chunks to the holder first, then the table that names their versions
  region.flush();
  const table = region.snapshotTable();
  storage.sql.exec(
    'INSERT OR REPLACE INTO heap_table (id, bytes) VALUES (1, ?)',
    table.buffer as ArrayBuffer
  );
}

export function touch(region: ElasticRegion): void {
  region.write(5 * MIB + 10, new Uint8Array([1, 2, 3]));
  const back = new Uint8Array(3);
  try {
    region.read(5 * MIB + 10, back);
  } catch (error) {
    if (error instanceof StaleChunkError) console.error('holder lost chunk', error.chunk);
    else throw error;
  }
  const { faults, hits, evictions, writeBacks } = region.stats();
  console.log({ faults, hits, evictions, writeBacks });
}

// chunks spread over peer objects instead: every fault is one stub call
export async function openPeerRegion(stubs: PeerStub[]) {
  const region = ElasticRegion.async({
    byteLength: 256 * MIB,
    chunkBytes: MIB,
    frames: 32,
    holder: peerHolder(stubs)
  });
  region.prefetch(0, 4 * MIB);
  const head = new Uint8Array(16);
  await region.read(0, head);
  await region.flush();
  return region;
}
```

### Choosing a Holder

`sqlHolder` keeps one row per chunk in the object's own SQLite and reads synchronously, so a fault costs a query and no stub call. `peerHolder` places chunk `i` on `stubs[i % stubs.length]` and reads asynchronously, so a fault is a stub call at about 7 ms over RPC in one colo, and one invocation can make 1,000 of them. A peer object keeps its chunks in memory and can lose them. Use a peer holder for data the owner can rebuild, or keep the storage copy at the owner. A chunk whose holder copy is missing or at another version raises `StaleChunkError`, and the version table must be restored with `restoreTable` after a restart or every chunk reads as never written.

The memory meter shapes chunk size and window. The platform meter charged linear memory at 1.00 MiB per MiB whether or not the pages were touched. On a bare object a single `ArrayBuffer` or `WebAssembly.Memory` of 128 MiB succeeded and one of 130 MiB or more was refused inside the runtime. Chunks of 32 MiB held 224 MiB without a reset and 256 MiB reset on every sample ([memory-ladder](https://github.com/gmitch215/folio/blob/master/experiments/memory-ladder/README.md), [platform-ladder](https://github.com/gmitch215/folio/blob/master/results/execution/platform-ladder/README.md)). Writing large amounts to an object's own storage also raised its meter, up to a ceiling near 36 MiB for rows of 6 KiB or more, and released it with time. Rows of 4 KiB held 1.9 MiB of 16 MiB written. These cells have one to three repeats ([spill-memory](https://github.com/gmitch215/folio/blob/master/results/execution/spill-memory/README.md)). The best chunk size for a given workload is not measured.

### Closed Mechanisms

Compressing evicted chunks does not pay on the fault path. A decoder must run faster than about 520 to 850 MiB/s, and the synchronous decoders in `node:zlib` read 257 MiB/s inside a deployed object, which makes a compressed fault cost 2.3 to 3.1 times the CPU of an uncompressed read from the object's own storage. Narrow arenas, which put several small windows in the module, read a tau of 1.75 to 2.80 for four arenas on Thunder admin where a prediction said 0.59 to 0.64. Translating every access of a PHP module costs a tau of 1.581 on the stock front page at default tiering. The dynamic guard count of an epoch design is 0.308 per access on admin, and its projected tau of 0.18 to 0.19 is a prediction ([Elastic Memory Study](TECHNICAL_REPORT.md#elastic-memory-study)).

**Limit.** `ElasticRegion` serves host code and explicit spans. A native Wasm guest cannot address a region transparently, and the software translation that would let it misses its gate on every PHP route. The managed page plane missed its gates on both Free plan days it ran, and a region has one trusted writer ([Elastic Memory](docs/studies/elastic-memory.md)).

## Pools in Combination

The pools split work in different ways and combine through one rule: the pool that validates the least needs the most from the caller. A task pool runs jobs the caller names on private workers. A slice pool runs slices of one call on a shared memory. A certified fold joins chunks of a stream with a proved formula. The router picks among them per call. The basics of each are in [Pools](docs/modules/pools.md) and [Folds and Certificates](docs/modules/folds-and-certificates.md).

### Task Pool With an Audit

A task pool checks nothing by default. `audit` reruns every `every`th task in the joining thread and compares the output bytes, so a job that depends on state the serial program would have shared throws `TaskConflictError` at the join.

```ts
import { peakConcurrency, serveTasks, TaskConflictError, TaskPool } from '@gmitch215/folio';
import { createHash } from 'node:crypto';
import { isMainThread, Worker, workerData } from 'node:worker_threads';

const sha256 = (input: string | Uint8Array) => createHash('sha256').update(input).digest('hex');

if (isMainThread) {
  // every second task runs again in this thread and the two outputs are compared byte for byte
  const pool = new TaskPool(4, {
    audit: {
      every: 2,
      run: (name, input) => {
        if (name !== 'sha256') throw new Error(`unknown task ${name}`);
        return sha256(input);
      }
    }
  });
  const workers = Array.from({ length: pool.size }, (_, index) => {
    const link = pool.link(index);
    return new Worker(new URL(import.meta.url), {
      workerData: { link },
      transferList: [link.port]
    });
  });
  try {
    const jobs = Array.from(
      { length: 8 },
      (_, index) => ['sha256', `chunk-${index}`.repeat(100_000)] as [string, string]
    );
    const results = await pool.run(jobs);
    console.log(results.map((result) => result.text().slice(0, 8)));
    console.log('peak concurrency', peakConcurrency(pool.drain()));
  } catch (error) {
    if (error instanceof TaskConflictError)
      console.error('tasks are not independent', error.message);
    else throw error;
  } finally {
    pool.close();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
} else {
  serveTasks(workerData.link, (name, input) => {
    if (name !== 'sha256') throw new Error(`unknown task ${name}`);
    return sha256(input);
  });
}
```

Eight batched `TaskPool` workers reach 2x or more on 18 of 21 corpus kernels with a learned-page reset and on 8 of 21 with the checkpoint reset ([reset-policies](https://github.com/gmitch215/folio/blob/master/results/corpus/reset-policies/README.md)). Eight named tasks of SHA-256 chains inside one PHP request ran 7.58x, and eight `preg` tasks with a 37% serial setup ran 2.14x ([Work Inside One PHP Request](TECHNICAL_REPORT.md#work-inside-one-php-request)).

### Slice Pool With a Serial Audit

`SlicePool` runs slices of one export over one shared memory, with one private stack per worker. With `audit: true` it replays the slices serially on a copy and compares every returned value and every byte below the stacks. [examples/slice-pool.ts](https://github.com/gmitch215/folio/blob/master/examples/slice-pool.ts) is the smallest program. Run the audit in tests and canaries, since it costs a serial execution and a memory copy.

Twenty of 30 corpus drivers run exact on the slice pool at 1.94x to 3.88x. Ten fail the output check because they share file-scope statics or an allocator cursor, and the audit threw `SliceConflictError` on seven of eight failing drivers tried and trapped on the eighth ([Slice Pool, Admission Quality and Mixed Record Sizes](TECHNICAL_REPORT.md#slice-pool-admission-quality-and-mixed-record-sizes)).

### Certified Folds as the Join

`certifyStream` proves from the module bytes that `entry(state, ptr, len)` is the left fold of one affine byte step for every length and split, or returns the reason it refused. A certificate lets `foldCertified` cut the stream into chunks, run each once on a worker and join the end states with a formula, with no comparison afterwards.

```ts
import {
  certifyStream,
  foldCertified,
  installPrefill,
  serveCertified,
  shareCertified,
  TaskPool,
  type StreamCertificate
} from '@gmitch215/folio';
import binaryen from 'binaryen';
import { isMainThread, Worker, workerData } from 'node:worker_threads';

// state = state * 31 + byte over the input; the checker proves that shape for every length
const source = binaryen.parseText(`(module
	(memory (export "memory") 32 512)
	(func (export "update") (param $state i32) (param $ptr i32) (param $len i32) (result i32)
		(local $byte i32)
		(block $skip (br_if $skip (i32.eqz (local.get $len)))
			(loop $each
				(local.set $byte (i32.load8_u (local.get $ptr)))
				(local.set $state (i32.add (i32.mul (local.get $state) (i32.const 31)) (local.get $byte)))
				(local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
				(br_if $each (local.tee $len (i32.add (local.get $len) (i32.const -1))))))
		(local.get $state)))`);
const bytes = Uint8Array.from(source.emitBinary());
source.dispose();

if (isMainThread) {
  const result = certifyStream(bytes, 'update');
  if (result.kind === 'refusal') throw new Error(`not certified: ${result.reason}`);
  const certificate: StreamCertificate = result;

  // the workers run the same module on one shared memory, with the input inside it
  const pages = 64;
  const subject = shareCertified(bytes, certificate, pages);
  const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
  installPrefill(subject, memory);
  const module = new WebAssembly.Module(subject.bytes as BufferSource);

  const pool = new TaskPool(4);
  const workers = Array.from({ length: pool.size }, (_, index) => {
    const link = pool.link(index);
    return new Worker(new URL(import.meta.url), {
      workerData: { module, memory, link, layout: certificate.layout },
      transferList: [link.port]
    });
  });
  try {
    const input = new Uint8Array(memory.buffer, 1 << 20, 1 << 20);
    input.forEach((_, index) => (input[index] = index * 7));

    const folded = foldCertified(pool, input, memory, certificate);

    // the serial call on a fresh instance, for comparison
    const serial = new WebAssembly.Instance(new WebAssembly.Module(bytes as BufferSource));
    new Uint8Array((serial.exports.memory as WebAssembly.Memory).buffer, 1 << 20).set(input);
    const update = serial.exports.update as (s: number, p: number, n: number) => number;
    const expected = BigInt(update(0, 1 << 20, input.length) >>> 0);
    console.log({ chunks: folded.chunks, state: folded.state, equal: folded.state === expected });
  } finally {
    pool.close();
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
} else {
  serveCertified(workerData.link, workerData);
}
```

All 7 valid compiled stream subjects certify (CRC-32C, CRC-16, CRC-64, a polynomial hash, an LCG, and miniz CRC-32 and Adler-32), and FNV-1a and the SHA-256 compression function are refused. One pass on shared memory at eight workers reads 3.4x to 4.1x at 8 MiB and 4.7x to 6.8x at 64 MiB at a CPU ratio of 1.02 to 1.10, with wide ranges between sessions ([Certified Stream Folds](TECHNICAL_REPORT.md#certified-stream-folds)). The checker is not formally verified, and every review of it came from the author's model family.

### The Router

`Router` chooses a route per call in a fixed order: the certified summary, the certified private window in place, an explicit runner the caller supplies, tracked speculation where its assumptions hold, and native serial otherwise. `decide` reports the choice without running the call, and `decision.considered` lists every route it tried and why each was refused. A refusal is cached like a certificate, keyed by the module hash, the backend and the checker versions.

```ts
import { decide, Router, type RouterCall } from '@gmitch215/folio';
import binaryen from 'binaryen';

// the same stream module as the certified fold: state = state * 31 + byte
const source = binaryen.parseText(`(module
	(memory (export "memory") 32 512)
	(func (export "update") (param $state i32) (param $ptr i32) (param $len i32) (result i32)
		(local $byte i32)
		(block $skip (br_if $skip (i32.eqz (local.get $len)))
			(loop $each
				(local.set $byte (i32.load8_u (local.get $ptr)))
				(local.set $state (i32.add (i32.mul (local.get $state) (i32.const 31)) (local.get $byte)))
				(local.set $ptr (i32.add (local.get $ptr) (i32.const 1)))
				(br_if $each (local.tee $len (i32.add (local.get $len) (i32.const -1))))))
		(local.get $state)))`);
const bytes = Uint8Array.from(source.emitBinary());
source.dispose();

const call: RouterCall = { kind: 'stream', entry: 'update', ptr: 1 << 20, len: 4 << 20 };
const options = { mode: 'router', pages: 128, workers: 4 } as const;

// the decision needs no run: it names the route, the reason and every route it considered
const { decision } = decide(bytes, call, options);
console.log(decision.route, decision.reason, decision.cacheHit);
for (const step of decision.considered) console.log(step.route, step.verdict, step.reason);

const router = await Router.open(bytes, call, options);
try {
  const input = new Uint8Array(router.memory.buffer, call.ptr, call.len);
  input.forEach((_, index) => (input[index] = index * 7));
  const run = await router.run();
  console.log(run.route, run.reason, run.state, run.wallMs);
} finally {
  await router.close();
}
```

A records call, a loop of independent calls, adds `regions` and `writes` lists to the call, and the window route needs an ownership certificate. `certifyOwnership` returns a window, a copy-out rule and the premises it relied on, or a typed refusal. The router must be given the real `regions` and `writes`, and a range left out of `writes` keeps the writes of the records after a trap.

### Where the Combination Pays

| Route                             | Measured                                                                                                                          | Source                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| One call on shared memory         | 7.619x at eight workers on a compute kernel, CPU ratio 1.037; streaming stops near four workers (3.497x at four, 3.474x at eight) | [scaling](https://github.com/gmitch215/folio/blob/master/results/execution/scaling/README.md)                         |
| Iteration route, outside program  | BLAKE3 2.0x to 3.1x under default admission; SHA-256 1.7x to 2.1x with a helper; LZ4 no gain                                      | [The Iteration Route](TECHNICAL_REPORT.md#the-iteration-route)                                                        |
| Ownership slice route             | 4.07x with six CPUs and 5.64x with ten at eight workers, one driver                                                               | [ownership-slice-rig](https://github.com/gmitch215/folio/blob/master/results/execution/ownership-slice-rig/README.md) |
| Router, frozen final corpus       | geomean 0.899 on x86_64 and 0.900 on arm64 against 1.20; serial for 46 of 47 drivers                                              | [final-evaluation](https://github.com/gmitch215/folio/blob/master/results/execution/final-evaluation/README.md)       |
| Automatic extraction, single call | default admission dispatches no worker on 21 library kernels                                                                      | [What the Corpus Shows](TECHNICAL_REPORT.md#what-the-corpus-shows)                                                    |

The classes that do not gain are calls whose serial time is under about 0.05 ms, programs whose records share an allocator or statics, loops whose output exceeds the undo log, and one uncached PHP render.

**Limit.** The router does not meet its speed gates on the frozen corpus, and the six ownership certificates are tested by three red team rounds and a re-audit, not proved. Certified folds cover GF(2), Z/2^w and two-residue folds, and a refusal says nothing about the function ([Router and Development Ablation](TECHNICAL_REPORT.md#router-and-development-ablation), [Ownership Certificate and the Slice Route](TECHNICAL_REPORT.md#ownership-certificate-and-the-slice-route)).

## Resetting and Bounding Guests

`InstanceCheckpoint` captures a private instance after initialization and restores its memory, mutable globals and table slots between jobs. `restore('changed')` compares every 64 KiB page with the initial copy and rewrites the pages that differ. `restore('full')` copies every byte. A range passed in `overwrite` is skipped when the caller writes every byte of it before anything reads it, so a job that rewrites its input region does not pay to compare and copy the previous job's input.

`governGrowth` caps `memory.grow`. The cap has to sit on `grow`, because an Emscripten glue tries the current size times 1.2, 1.1 and 1.05, floored at the request, and a cap on the requested size let one build reach 115.25 MiB under a 104 MiB cap. Governors stack, a later one calls the one it replaced, and `restore` runs in reverse install order.

```ts
import { ContextResetError, InstanceCheckpoint, prepareContext } from '@gmitch215/folio';
import { governGrowth } from '@gmitch215/folio/memory';
import { readFileSync } from 'node:fs';

// one private instance, reset between jobs; a job that rewrites its input region each time lets
// the checkpoint skip comparing it
const plan = prepareContext(readFileSync(new URL('../build/fixture.wasm', import.meta.url)));
if (plan.reasons.length) throw new Error(`create a fresh instance per job: ${plan.reasons}`);

const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
const instance = new WebAssembly.Instance(new WebAssembly.Module(plan.bytes as BufferSource), {
  env: { memory }
});
const mix = instance.exports.mix as (address: number, rounds: number) => number;
new Uint32Array(memory.buffer, 1024, 4).set([11, 22, 33, 44]);

const checkpoint = new InstanceCheckpoint(instance, plan);
const governor = governGrowth(memory, { capBytes: 2 * 65536 });

for (const rounds of [100, 5000]) {
  mix(1024, rounds);
  // the first 64 bytes are written in full before each job reads them
  const report = checkpoint.restore('changed', [{ offset: 1024, length: 64 }]);
  console.log({ rounds, changedPages: report.changedPages, skipped: report.skippedBytes });
}

try {
  memory.grow(1);
} catch {
  console.log('refused grows', governor.refused);
}
governor.restore();

try {
  checkpoint.restore();
} catch (error) {
  if (error instanceof ContextResetError) console.log(error.kind, '-> create a new context');
  else throw error;
}
```

On an Emscripten PHP 8.5 build with a 100 MiB cap, a 64 MiB string request had all three glue attempts refused. PHP printed `[error] Out of memory`, `_run` threw `ExitStatus` with status 1, PHP's own `catch` never ran, memory stayed at its 96 MiB boot size, and shutdown, startup and `1+1` still worked. At a 104 MiB cap the request fit after two refusals and finished at 107,610,112 bytes ([growth-governor](https://github.com/gmitch215/folio/blob/master/experiments/growth-governor/README.md)). [examples/growth-governor.ts](https://github.com/gmitch215/folio/blob/master/examples/growth-governor.ts) runs the same glue loop without PHP.

Three reset policies were measured on 21 kernels for eight batched workers: `whole` copies the arena, `pages` rewrites the pages that the first run of a fixed input changed, and `checkpoint` is `restore('changed')`. On the Ryzen machine `pages` led `checkpoint` and `checkpoint` led `whole` on all 21 kernels. SHA-256 read 0.92x, 3.79x and 2.52x. The library ships `checkpoint` and `full`. The `pages` policy lives in the study harness and holds only for unchanged code, input and host state ([reset-policies](https://github.com/gmitch215/folio/blob/master/results/corpus/reset-policies/README.md)).

**Limit.** Growth cannot be undone, so a context whose memory or table grew has to be recreated, and host resources and objects behind `externref` values are reset by the caller. The governor guards linear memory and turns a platform memory reset into a failed request. It does not bound the JavaScript-side charge, and the cap for a given build is unmeasured: one build held 113.9 MiB after its workload, which a 112 MiB cap would refuse ([Storage Resets and the Growth Governor](TECHNICAL_REPORT.md#storage-resets-and-the-growth-governor)).

## Reading the Evidence

Every run returns an `ExecutionReport`. Read `mode` first: `serial`, `speculative` or `native-shared`. A serial run carries a `reason`, such as `small-workload`, `no-parallel-plan` or `unsupported-module`, and an iteration run carries the counts of dispatched, replayed and serial iterations and what stopped the dispatch. A passing run does not mean workers ran, so check `workers`.

```ts
import { Folio, prepare } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

const program = prepare(readFileSync(new URL('../build/fixture.wasm', import.meta.url)));
const memory = new WebAssembly.Memory({ initial: 2, maximum: 8192, shared: true });
const folio = await Folio.open(program, { memory, workers: 4, profile: true });
try {
  new Uint32Array(memory.buffer, 1024, 64).fill(1);
  const report = await folio.run('program', [1024, 64, 1_000_000]);

  // mode and reason say whether anything ran in parallel and why not
  console.log(report.mode, report.reason ?? 'no reason recorded', report.workers);
  // regions found, regions replayed after a conflict, regions that fell back to the owner
  console.log(report.regions, report.replayed, report.fallbacks);
  console.log(report.iteration?.stopped, report.profile?.validationMs);
} finally {
  await folio.close();
}
```

### What Results Holds

`results/<topic>/<study>/` holds one study. Its `README.md` names the question, the instrument and the artifacts. `raw.jsonl` holds the samples, `summary.json` the deterministic summary, and `manifest.json` the bytes and SHA-256 of every file. Never edit a summary by hand: `scripts/research/export.ts` writes it from the raw rows. Deployed and local records stay separate, and a deployed row reports module UUIDs, which count module instances and are not isolate identities.

Read a figure with three things beside it: the instrument, the machine and the sample count. A Node wall clock, a deployed `cpuTime` reading and a platform tail event are different instruments. A claim about speed needs a paired measurement with the raw samples under `results/` and the instrument named.

### Verifying

```sh
node scripts/research/evidence.ts
node scripts/research/evidence.ts --summaries
bun scripts/analyze/run.ts
```

The first command checks every manifest and the historical index against the bytes on disk. The second regenerates the summaries in a temporary copy and compares their bytes. The third writes the regenerated summaries into the tree.

### Adding a Measurement

1. Write the study README first. The export refuses to write a manifest without it.
2. Run the instrument on a quiet host and record the load average in the data. Discard a run that overlapped other work.
3. Copy the run in with `node scripts/research/export.ts results/topic/study run.jsonl:raw.jsonl`. It refuses to overwrite a file and writes the summary and the manifest.
4. Name arms by mechanism, record why a repeat was made in the README, and add a new record instead of overwriting a finished run.
5. Run `node scripts/research/evidence.ts` and read the diff.

**Limit.** Timing in this repository comes from a Ryzen 9 9900X and an Apple M2 Pro, and no figure is replicated on a third machine. A deployed study reads one account and one day unless its README says more.
