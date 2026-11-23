# Workers

## Overview

`@gmitch215/folio/workers` is the entry for hosts that cannot create threads or compile WebAssembly at request time, such as Cloudflare Workers and Durable Objects. It exports two clients.

`RemoteFolio` is the portable client. A Worker keeps its URL and asks a Folio execution host to run a registered artifact. Sharing happens inside the host, and requests and results cross a serialized transport. The client uses `fetch` or a service binding, imports nothing from Node and compiles no Wasm. `FolioHost` is the other end, described in [Core](core.md). `encodeValue`, `decodeValue`, `encodeBytes`, `decodeBytes`, `RemoteError` and `UncertainDelivery` belong to the same client.

`ManagedFolio` runs a program entirely inside managed Workers and Durable Objects. The original Wasm stack and its JSPI coordinator stay in the owner. Region batches travel as binary frames, with a frozen copy of memory, to lane objects that run a tracked module. The owner validates the results in order and commits them. Memory is copied and kept coherent, and none of it is shared. `FolioLane` is the lane runtime. A transport failure falls back to native execution at the owner. The frame codec in `src/remote/frames.ts` is internal and the entry does not export it.

Use `RemoteFolio` when a host that can share memory already exists and the Worker is the edge in front of it. Use `ManagedFolio` when everything must stay on the platform. A run returns a `ManagedReport`:

```text
speculative 4 64 0
```

That line is the mode, the number of lanes that ran regions, the regions dispatched and the transport fallbacks for four in-process lanes over the generalized fixture. The managed backend discovered 64 regions on the same program in the deployed run in [Managed Coherent Backend](../../TECHNICAL_REPORT.md#managed-coherent-backend).

## Getting Started

This example deploys nothing. It runs four in-process lanes on Node 26, which has JSPI. Run `bun run build:c` first so that `build/generalized.wasm` exists.

```ts
import { prepare } from '@gmitch215/folio';
import { FolioLane, ManagedFolio, type ManagedLaneTransport } from '@gmitch215/folio/workers';
import { readFileSync } from 'node:fs';

const bytes = Uint8Array.from(readFileSync('./build/generalized.wasm'));
const program = prepare(bytes, { minimumRegionWork: 0 });
if (!program.control) throw new Error(program.controlReasons?.join('; '));

const { coordinator, transactional, workerOriginal: _, ...control } = program.control;
const artifact = {
  original: new WebAssembly.Module(bytes),
  coordinator: new WebAssembly.Module(Uint8Array.from(coordinator)),
  transactional: new WebAssembly.Module(Uint8Array.from(transactional)),
  control
};

const lanes: ManagedLaneTransport[] = Array.from({ length: 4 }, () => {
  const lane = new FolioLane(artifact.transactional, {
    initial: control.initial,
    maximum: control.maximum
  });
  return { execute: async (frame) => lane.execute(frame), close: async () => lane.close() };
});

const memory = new WebAssembly.Memory({
  initial: control.initial,
  maximum: control.maximum,
  shared: true
});
const folio = new ManagedFolio(artifact, { memory, lanes });
try {
  new Uint32Array(memory.buffer, 1024, 64).fill(17);
  const report = await folio.run('main', [1024, 64, 100]);
  console.log(report.mode, report.workers, report.regions, report.transportFallbacks);
  console.log(report.transportBytes);
} finally {
  await folio.close();
}
```

`prepare` runs at build time and returns the coordinator, the tracked region module and the control plan. Nothing compiles at request time on the Workers path, so a Worker bundles the three modules and the plan. `minimumRegionWork: 0` admits every pure region, which the small input needs. The default threshold keeps a region at its owner unless its estimated work pays for dispatch.

A `ManagedFolio` without a control plan, without JSPI or with a single lane runs the original module natively. `folio.diagnostics` names the reason. `report.transportBytes` is the `{ sent, received }` size of the encoded frames. `close()` waits for the active run and closes every lane, and a lane whose disposer fails does not stop the others from closing.

The same program runs on a local workerd with Durable Object lanes:

```sh
node experiments/managed/prepare.ts
node experiments/managed/local.ts
```

The harness prints `passed`, the row count, whether JSPI was present and whether every whole-memory comparison was exact. See [the managed procedure](https://github.com/gmitch215/folio/blob/master/experiments/managed/METHOD.md) before provisioning a deployed run.

## Intermediate

### Durable Object Lanes

A lane is any object that can take a binary frame and return a binary response. On Workers the lane is a Durable Object that holds one `FolioLane`, and the owner is another object that holds the `ManagedFolio`. Durable Object lanes run on their own isolates and overlap.

```ts no-check
import type { ManagedArtifact } from '@gmitch215/folio/workers';
import { FolioLane, ManagedFolio } from '@gmitch215/folio/workers';
import { DurableObject } from 'cloudflare:workers';
import coordinator from './build/coordinator.wasm';
import metadata from './build/metadata.json';
import original from './build/original.wasm';
import transactional from './build/transactional.wasm';

const artifact: ManagedArtifact = {
  original,
  coordinator,
  transactional,
  control: metadata.control,
  memories: metadata.memories
};

export class Lane extends DurableObject {
  #lane?: FolioLane;

  execute(frame: Uint8Array): Uint8Array {
    this.#lane ??= new FolioLane(transactional, {
      initial: metadata.control.initial,
      maximum: metadata.control.maximum
    });
    return this.#lane.execute(frame);
  }

  retire(): void {
    this.#lane?.close();
    this.#lane = undefined;
  }
}

interface Env {
  LANES: DurableObjectNamespace<Lane>;
}

export class Owner extends DurableObject<Env> {
  async compute(width: number): Promise<number> {
    const lanes = Array.from({ length: width }, (_, index) => {
      const stub = this.env.LANES.get(this.env.LANES.idFromName(`lane-${index}`));
      return {
        execute: (frame: Uint8Array) => stub.execute(frame),
        close: async () => stub.retire()
      };
    });
    const folio = new ManagedFolio(artifact, { lanes });
    try {
      new Uint32Array(folio.memory.buffer, 1024, 64).fill(17);
      const report = await folio.run('main', [1024, 64, 100]);
      return report.regions;
    } finally {
      await folio.close();
    }
  }
}
```

`prepare` produced `metadata.json` and the three `.wasm` files at build time. `experiments/managed/prepare.ts` shows the script. The owner builds the pool, runs and closes inside one invocation. A reusable session cannot assume that an owner keeps in-memory state between requests. In the [state-loss analysis](../../TECHNICAL_REPORT.md#costs-snapshot-limits-and-state-loss) the module identifier changed in 14, 15 and 45 later operations of three request-separated arrangements and in none of 56 direct calls inside one invocation.

When `artifact.memories` lists the source module's imported memory limits, `ManagedFolio` creates the memory itself and exposes it as `folio.memory`. Pass `memory` to bind one yourself. The canonical memory must fit the owner's budget.

### Transports

A transport is the `execute(frame)` function, so a lane can sit behind RPC, a binary `fetch`, a streamed `fetch` or a WebSocket. A WebSocket needs `binaryType = 'arraybuffer'`, because the default blob events produce invalid frames and trigger the native fallback. The managed transport study ran 64 regions on all four transports. Medians of two samples, with serial at 572.0 ms:

| Transport                   | Two lanes | Four lanes | Eight lanes |
| --------------------------- | --------: | ---------: | ----------: |
| Batched RPC bytes           |  473.5 ms |   370.0 ms |    358.0 ms |
| Binary fetch                |  472.5 ms |   353.5 ms |    357.0 ms |
| Streamed binary fetch       |  537.5 ms |   398.5 ms |    360.0 ms |
| Persistent binary WebSocket |  453.0 ms |   381.0 ms |    357.5 ms |

Each timed row includes preparation, lane admission, a serial oracle and the joined close, so these are end-to-end figures. The best paired improvement is 1.618x, with four-lane binary fetch. They are not kernel speedups. The source is [Managed Coherent Backend](../../TECHNICAL_REPORT.md#managed-coherent-backend).

### Frame and Snapshot Options

Frames carry the whole snapshot by default. `maximumSnapshotBytes` caps the arena a run may copy and defaults to 31 MiB. `maximumFrameBytes` caps one request frame and defaults to the snapshot limit plus 1 MiB, capped 4 KiB below the 32 MiB Workers RPC argument limit. A frame over the cap is not sent, the call runs at the owner and `diagnostics` names the frame size and the limit. `snapshotEncoding: 'auto'` omits pages that are all zero, which saves traffic for sparse arenas. Lanes from release 1.0.0 reject its frames, so the default stays `dense`. `maxTransactionBytes` is the tracking budget of one lane batch, the bytes its regions may report as read or written, 262,144 by default.

### Ranges, Runs, Memo and Fuel

Four options change what a call costs. All are off unless set.

```ts
import {
  ManagedFolio,
  type ManagedArtifact,
  type ManagedLaneTransport
} from '@gmitch215/folio/workers';

declare const artifact: ManagedArtifact;
declare const lanes: ManagedLaneTransport[];
declare const memory: WebAssembly.Memory;

const folio = new ManagedFolio(artifact, {
  memory,
  lanes,
  ranges: { maxRounds: 3 },
  runs: true,
  fuel: 1_000_000_000,
  memo: { entries: 1024 }
});
const report = await folio.run('main', [1024, 64, 100]);
console.log(report.rangeBytes, report.rounds, report.rangeFallbacks, report.memoHits);
```

`ranges` ships the byte ranges a region reads and writes, learned from earlier calls, in place of a snapshot. A lane that reads outside what it received reports an escape, the owner widens the footprint and retries up to `maxRounds` times, and then falls back to a snapshot or to native execution at the owner. The owner recomputes escapes from the returned read set and never trusts a lane's own flag. A lane that predates the protocol rejects the frame. In the range-lanes study an 8 MiB arena shipped 0.1% to 0.2% of the snapshot's bytes, and a 32 MiB arena ran where snapshot mode cannot send it. See [Range Lanes](../../TECHNICAL_REPORT.md#range-lanes).

`inline` on a `FolioLane` runs a module that tracks accesses in its own code, so a lane no longer calls back into JavaScript on every load and store. It takes that module and an optional `logEntries` bound, 8192 by default. The module comes from `inlineLane` in `src/iteration/inline.ts`, which the package entries do not export, so the option serves callers who build from the repository. The managed corpus transfer measured the lane cost per record falling 6 to 23 times with inline tracking. See [Managed Corpus Transfer](../../TECHNICAL_REPORT.md#managed-corpus-transfer).

`runs: true` makes lanes answer in sorted byte runs that the owner validates and commits as intervals. A lane that predates runs answers in addresses, which the owner still decodes exactly, and `runReplies` counts both.

`memo` reuses a recorded result when the bytes a region read are unchanged. A hit goes through the same ordered validation as a lane result, and a region that trapped, ran out of fuel or escaped is never recorded. Reuse beats serial execution only where repetition is high and a region costs much more than hashing its reads. At 90% repeated records the speedup over native serial was 4.76 to 5.01 on the partitioned kernel. See [Region Reuse](../../TECHNICAL_REPORT.md#region-reuse).

`fuel` bounds the speculative back-edges of one call, 100,000,000 by default and at most 1,000,000,000. A call that runs out finishes natively at the owner and the lane's time is wasted. A call that needs about 268 million back-edges exhausted the default on every call and ran at 0.84 to 0.90 of serial wall. Raising `fuel` to its maximum gave a 1.99 speedup. A caller that knows its calls are long should pass a larger `fuel`. See [Speculative Fuel](../../TECHNICAL_REPORT.md#speculative-fuel).

### Lane Placement

Lane placement decides whether lanes overlap. Service-bound Worker lanes share a thread with their caller, so four of them take as long as one lane run four times. Durable Object lanes run on their own isolates and overlap. The lane-concurrency study measured an overlap index, where 1.0 is full overlap and 4.0 is serial, at calls of about 100 ms and 380 ms:

| Lane type                      | Index at 100 / 380 ms |
| ------------------------------ | --------------------- |
| four service-bound Workers     | 4.07 / 3.87           |
| four Durable Object instances  | 1.42 / 1.42           |
| four direct top-level requests | 1.84 / 1.48           |

Use Durable Object lanes for the managed transport. A decomposition that fits a managed lane is a few large explicit units with a merge the caller declares, such as SQLite shards that each scan a row-id range. A loop of small records does not pay for a lane call. The sharded SQLite probe ran 1,000,000-row queries 2.04x to 9.68x faster than one object at four and eight shards, with every returned result equal to the serial one. See [Lane Concurrency](../../TECHNICAL_REPORT.md#lane-concurrency) and [SQLite on Durable Object Lanes](../../TECHNICAL_REPORT.md#sqlite-on-durable-object-lanes).

### The Portable Client

`RemoteFolio.open(url, artifact, options)` opens a session on an artifact that the host registered. `workers` asks for a group width within the host's limits.

```ts
import { RemoteError, RemoteFolio, UncertainDelivery } from '@gmitch215/folio/workers';

interface Env {
  HOST: { fetch(request: Request): Promise<Response> };
  TOKEN: string;
}

export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    const input = new Uint8Array(1024).fill(7);
    const remote = await RemoteFolio.open('https://host.internal/folio', 'fixture', {
      fetch: (request) => env.HOST.fetch(request),
      headers: { authorization: `Bearer ${env.TOKEN}` },
      workers: 4
    });
    try {
      await remote.write(1024, input);
      const report = await remote.run('program', [1024, 256, 1000]);
      const output = await remote.read(1024, input.length);
      return Response.json({ mode: report.mode, workers: report.workers, bytes: output.length });
    } catch (error) {
      if (error instanceof UncertainDelivery) await remote.retryPending();
      else if (error instanceof RemoteError)
        return new Response(error.kind, { status: error.status });
      throw error;
    } finally {
      await remote.close();
    }
  }
};
```

Each session has an unforgeable random capability and a monotonic sequence number. The client caches its last accepted request. When a response is lost, `run`, `read`, `write` or `close` throws `UncertainDelivery`, and `retryPending()` resends the exact request. The host returns its cached result without repeating effects. The cache is bounded and held in memory, so it gives no exactly-once effects across host restarts. A new request is refused until the uncertain one is retried. `RemoteError` carries the HTTP `status` and the host's error `kind`. `maximumResponseBytes` bounds what the client reads and defaults to 2 MiB.

`run(entry, args, options)` takes `parallel: 'auto' | 'off' | 'speculate'` and `maximumWorkers`. The returned `RemoteReport` has the decoded values, `mode`, the regions dispatched and the reason a run stayed serial. `await using` works on both clients.

The value codec carries number bit patterns, BigInts and `undefined` across the boundary. References and executable objects do not cross it.

```ts
import { decodeValue, encodeValue } from '@gmitch215/folio/workers';

const wire = JSON.stringify(encodeValue({ count: 3n, ratio: NaN, label: 'a', none: undefined }));
const back = decodeValue(JSON.parse(wire));
console.log(back.count, back.ratio, back.label);
```

The local control for this route is a stock workerd with a service binding to the authenticated Node host. Four distinct Folio threads executed the C entry and all 131072 bytes matched an untouched oracle. See [Execution Host and Portable Client](../../TECHNICAL_REPORT.md#execution-host-and-portable-client).

### Keeping the Client Portable

`src/managed/index.ts`, `src/remote/frames.ts`, `src/remote/index.ts` and `src/remote/values.ts` stay free of Node imports and of runtime Wasm compilation, so they run unchanged on Node, Workers and browsers. A change to any of them keeps that property.

## Limits

- The canonical memory must fit the owner's budget. The managed backend has no distributed page ownership, residency leases or native memory larger than the owner. See [Managed Coherent Backend](../../TECHNICAL_REPORT.md#managed-coherent-backend).
- A frame over the limit is not sent. At a 32 MiB snapshot every lane call failed, because the serialized frame was 33,554,540 bytes against the platform's 32 MiB RPC argument limit, so the default is 31 MiB. A deployed run at the 31 MiB default is not measured. See [Costs, Snapshot Limits and State Loss](../../TECHNICAL_REPORT.md#costs-snapshot-limits-and-state-loss).
- An owner cannot assume that its state survives between requests. Build the pool and run in one invocation.
- Service-bound Worker lanes ran CPU work serially at calls of 100 ms and longer. One account and one coordinator location produced the overlap figures. See [Lane Concurrency](../../TECHNICAL_REPORT.md#lane-concurrency).
- Managed Workers have no aggregate CPU measurement. The managed corpus kernels that win on the iteration route lose on managed lanes, because the cost is per tracked address, and no deployed measurement of a corpus kernel exists. See [Managed Corpus Transfer](../../TECHNICAL_REPORT.md#managed-corpus-transfer).
- `snapshotEncoding: 'auto'` is exact in unit tests and has no deployed measurement.
- `RemoteFolio` has been run against a local workerd. A publicly deployed Worker to host endpoint and its network latency are not measured. See [Execution Host and Portable Client](../../TECHNICAL_REPORT.md#execution-host-and-portable-client).
- `module UUID` values in a managed report identify module instances. They are not isolate identities.

[Limits](../limits.md) lists the limits that cross modules.

## See Also

- The API reference for `@gmitch215/folio/workers`, generated from `src/workers.ts`.
- [Core](core.md) for `FolioHost`, the execution host that `RemoteFolio` talks to.
- [Browser](browser.md) for the platform that has no JSPI.
- [Continuation](continuation.md) for long jobs across Durable Object events.
- [Managed Cloudflare Deployment](../../TECHNICAL_REPORT.md#managed-cloudflare-deployment) in the technical report.
- [Parallel Execution](../studies/parallel-execution.md) for the studies behind the measured costs.
