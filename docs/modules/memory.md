# Memory

## Overview

`@gmitch215/folio/memory` holds linear memory that outlives one call. It exports three groups of tools.

- `governGrowth` caps `memory.grow` on one `WebAssembly.Memory`, so a guest that outgrows its budget fails its own allocation and keeps running, in place of the platform resetting the object.
- `PageDirectory`, `MemoryPageOwner`, `ResidentPageLease` and the `PageOwner` transport contract keep page metadata in a directory, keep page bytes at owners and hand bounded resident copies to callers as leases.
- `ElasticRegion` and `AsyncElasticRegion` address a byte range larger than the window of chunk frames that holds it. `sqlHolder`, `peerHolder` and `peerStore` are the stores behind a region, and `StaleChunkError` is the refusal for a chunk whose stored copy is old or missing.

Use the governor to turn an out-of-memory reset into a failed request. Use a directory when several owners hold pages of one logical arena. Use a region when a Durable Object needs a heap larger than the memory it can keep resident.

The helpers for imported memory limits, the iteration arena layout and the hash-verified lease cache live in `src/memory/` and are internal. The entry does not export them. Boot images and checkpoints, which the same folder implements, have their own entries: [Boot](boot.md) and [Continuation](continuation.md).

A refused grow looks like this:

```text
refused 6291456 23068672
memory.grow to 23068672 bytes exceeds the 8388608 byte cap
6291456 1
```

## Getting Started

`governGrowth(memory, { capBytes, onRefuse })` wraps the memory's `grow` method and throws a `RangeError` for any grow whose final size would pass `capBytes`.

```ts
import { governGrowth } from '@gmitch215/folio/memory';

const memory = new WebAssembly.Memory({ initial: 64, maximum: 4096 });
const governor = governGrowth(memory, {
  capBytes: 8 * 1024 * 1024,
  onRefuse: ({ fromBytes, toBytes }) => console.log('refused', fromBytes, toBytes)
});

memory.grow(32);
try {
  memory.grow(256);
} catch (error) {
  console.log((error as Error).message);
}
console.log(memory.buffer.byteLength, governor.refused);

governor.restore();
```

An Emscripten guest then sees `emscripten_resize_heap` fail and reports out of memory, with its memory left at its size. The cap sits on `grow` because the glue first tries the current size times 1.2, then 1.1 and 1.05, floored at the request. A cap on the requested size lets those attempts through. A fractional page count is truncated, as a native grow truncates it, so the check sees the same target the engine would use.

`capBytes` must be a positive integer, or `governGrowth` throws a `RangeError`. `governor.refused` counts the grows turned away. `restore()` puts back the `grow` method that was there before.

The [growth-governor example](https://github.com/gmitch215/folio/blob/master/examples/growth-governor.ts) drives the Emscripten resize loop by hand, and the [experiment](https://github.com/gmitch215/folio/blob/master/experiments/growth-governor/README.md) runs a PHP guest under a cap.

## Intermediate

### Stacked Governors

Governors stack. A later one calls the one it replaced, so both caps hold and the lower one decides. `restore()` must run in reverse install order, and a restore out of order throws.

```ts
import { governGrowth } from '@gmitch215/folio/memory';

const memory = new WebAssembly.Memory({ initial: 64, maximum: 4096 });
const outer = governGrowth(memory, { capBytes: 64 * 1024 * 1024 });
const inner = governGrowth(memory, { capBytes: 8 * 1024 * 1024 });

// both caps hold; the lower one decides
try {
  memory.grow(256);
} catch {
  // a RangeError, as a guest's resize loop sees it
}

inner.restore();
outer.restore();
```

A cap below the memory's current size refuses every grow and does not shrink the memory.

### Page Directories and Leases

A `PageDirectory` is a bounded, volatile manifest coordinator. Canonical state is a list of page, version and owner references plus explicit zero-page declarations, with no contiguous heap. The wasm32 domain holds up to 65,536 pages of 64 KiB, and logical growth with `grow(pages)` allocates metadata only.

```ts
import { MemoryPageOwner, PageDirectory, pageBytes } from '@gmitch215/folio/memory';

const scope = { tenant: 'site', session: 'session-1', incarnation: crypto.randomUUID() };
const owners = [
  new MemoryPageOwner('a', scope, 64 * pageBytes),
  new MemoryPageOwner('b', scope, 64 * pageBytes)
];
const directory = new PageDirectory({ scope, owners, initialPages: 16 });

const lease = await directory.acquire({ read: [0], write: [1, 2] });
lease.view(1)[0] = 7;
await lease.commit();

console.log(directory.inspect(1));
console.log(await directory.collect());
```

`acquire` locks every requested page or none. Readers share a page and a writer excludes every other lease, so an overlapping request fails with a conflict. `lease.view(page)` returns a private copy of one page. `commit()` stages every written page at its owner, checks the lease again and publishes the whole manifest in one synchronous decision. A failure or a lost response leaves the previous manifest intact. `abort()` drops local changes. `collect()` retries idempotent deletion of retired versions, and a late stage request for a discarded version is fenced out.

A scope names a tenant, a session and a directory incarnation, and increasing fences identify immutable versions. One trusted directory may be active per scope. After a restart, use a new incarnation. A `PageOwner` is the transport boundary, with `read`, `stage` and `discard`. `MemoryPageOwner` is the bounded reference owner, and it keeps pages in memory.

Owner storage, leases, resident pages, commit snapshots and retired-version metadata have finite credits. `PageDirectoryOptions` sets them: `maximumLeases` (64), `maximumLeasePages` (256), `maximumResidentPages` (512), `maximumRetiredPages` (1024) and `leaseMilliseconds` (30,000). A lease that outlives its time is released. Credits are not RSS measurements, and an escaped view cannot be revoked once the lease releases.

### Elastic Regions

An `ElasticRegion` holds `byteLength` bytes through a window of `frames` chunks of `chunkBytes` each. `chunkBytes` is a power of two from 4 KiB to 8 MiB, and `byteLength` is a whole number of chunks. A miss fetches the chunk from a holder. A write marks its frame dirty, and an eviction or `flush()` writes the chunk back with a raised version. A chunk that was never written reads as zeros without a holder call.

```ts
import {
  ElasticRegion,
  StaleChunkError,
  sqlHolder,
  type ElasticSql
} from '@gmitch215/folio/memory';
import { DurableObject } from 'cloudflare:workers';

export class Heap extends DurableObject<Record<string, never>> {
  readonly #sql: ElasticSql;
  readonly #region: ElasticRegion;

  constructor(ctx: DurableObjectState, env: Record<string, never>) {
    super(ctx, env);
    this.#sql = ctx.storage.sql;
    this.#sql
      .exec(
        'CREATE TABLE IF NOT EXISTS heap_versions (id INTEGER PRIMARY KEY, versions BLOB NOT NULL)'
      )
      .toArray();
    this.#region = new ElasticRegion({
      byteLength: 256 * 1048576,
      chunkBytes: 1048576,
      frames: 8,
      holder: sqlHolder(this.#sql)
    });
    const saved = this.#sql.exec('SELECT versions FROM heap_versions WHERE id = 1').toArray()[0];
    if (saved) this.#region.restoreTable(new Uint32Array(saved.versions as ArrayBuffer));
  }

  write(offset: number, bytes: Uint8Array): void {
    this.#region.write(offset, bytes);
  }

  read(offset: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    try {
      this.#region.read(offset, out);
    } catch (error) {
      if (error instanceof StaleChunkError) console.log(error.chunk, error.expected, error.found);
      throw error;
    }
    return out;
  }

  // no await between the flush and the table row, so both land in one commit
  commit(): void {
    this.#region.flush();
    this.#sql
      .exec(
        'INSERT OR REPLACE INTO heap_versions (id, versions) VALUES (1, ?)',
        this.#region.snapshotTable().buffer as ArrayBuffer
      )
      .toArray();
  }
}
```

The version table lives in the instance. After a restart, restore it with `restoreTable` from a copy the owner persisted, or every chunk reads as never written. `restoreTable` needs a region with no dirty or pinned frame. `sqlHolder(sql, table, region)` keeps one row per region and chunk in a table that it creates on first use, so one table can serve several regions by name. A holder copy older than the table throws `StaleChunkError` with the chunk, the expected version and the version found, and `stats().staleRefusals` counts it. The region keeps working after a refusal.

`view(offset, length)` returns a view inside one chunk, valid until the next call that can fault. Two views of a resident chunk share a buffer. A read leaves the chunk clean, so a write through a view needs `touch(offset, length)` to mark it dirty. `pin` keeps a frame resident until `unpin(view, dirty)`, and a miss with every frame pinned throws a `RangeError`. `copyIntoMemory` and `copyFromMemory` move bytes between a region and a `WebAssembly.Memory`. `stats()` returns the counters: `faults`, `hits`, `zeroFills`, `writeBacks`, `evictions`, `bytesIn`, `bytesOut` and `staleRefusals`.

`AsyncElasticRegion` is the asynchronous form, over an `AsyncHolder`. Its operations run one at a time. `prefetch(offset, length)` starts loads into free frames without evicting or waiting, and `settled()` waits for them. `peerHolder(stubs)` spreads chunk `i` over `stubs[i % stubs.length]`, and `peerStore()` is the object a peer exposes.

```ts
import {
  AsyncElasticRegion,
  peerHolder,
  peerStore,
  type PeerRecord
} from '@gmitch215/folio/memory';
import { DurableObject } from 'cloudflare:workers';

export class Peer extends DurableObject {
  readonly #chunks = peerStore();

  get(index: number): Promise<PeerRecord | undefined> {
    return this.#chunks.get(index);
  }

  put(index: number, version: number, bytes: Uint8Array): Promise<void> {
    return this.#chunks.put(index, version, bytes);
  }
}

interface Env {
  PEERS: DurableObjectNamespace<Peer>;
}

export class Owner extends DurableObject<Env> {
  async fill(): Promise<number> {
    const stubs = Array.from({ length: 4 }, (_, index) =>
      this.env.PEERS.get(this.env.PEERS.idFromName(`peer-${index}`))
    );
    const region = new AsyncElasticRegion({
      byteLength: 64 * 1048576,
      chunkBytes: 1048576,
      frames: 4,
      holder: peerHolder(stubs)
    });
    region.prefetch(0, 4 * 1048576);
    await region.settled();
    await region.write(0, new Uint8Array(1024).fill(9));
    await region.flush();
    return region.stats().writeBacks;
  }
}
```

A peer may lose its chunks. A peer holder alone suits data the owner can rebuild, and a peer in front of storage needs the owner to keep the storage copy. A chunk the peer dropped is refused as missing.

## Limits

- The governor guards linear memory only. It turns a platform memory reset into a failed request and does not bound the JavaScript-side charge. The cap value for a given build is unmeasured: the request-reuse arm of one earlier build held 113.9 MiB after its full workload, which a 112 MiB cap would refuse. See [Storage Resets and the Growth Governor](../../TECHNICAL_REPORT.md#storage-resets-and-the-growth-governor).
- The measured platform line is about 203 MiB on the platform meter, taken from the host report for one Drupal distribution on Durable Objects. The documented 128 MB and that measured line are unreconciled, and the meter reading is the measured one. No deployed fix completed the failing routes of that distribution. See [A Drupal Distribution on Durable Objects](../../TECHNICAL_REPORT.md#a-drupal-distribution-on-durable-objects) and [Memory Accounting](../studies/memory-accounting.md).
- The page directory is volatile. It has no crash recovery and no durable owners. Recovery needs a persisted manifest, a transaction decision log and durable or replicated owners. The measured evidence is local protocol evidence with copied pages and explicit spans. It does not cover deployed aggregate capacity or transparent native Wasm paging. See [Distributed Page Ownership and Writeback](../../TECHNICAL_REPORT.md#distributed-page-ownership-and-writeback).
- Elastic memory for a PHP guest is open. Software translation of every access did not meet its gate: on a quiet rig, tau for the full path read 1.581 on the stock front page. Compressed pages on the fault path are closed, because a deployed object decoded at 257 MiB/s and the fault needs 520 to 850 MiB/s. Narrow arenas are refuted: four arenas on Thunder admin read a tau of 1.75 to 2.80 against a predicted 0.59 to 0.64. The dynamic guard count of 0.308 per access on Thunder admin predicted a tau of about 0.18 to 0.19 for an epoch design, and the built per-base epoch arm read 0.783 on admin, so that mechanism is closed at the current shapes. Each result closes a mechanism and leaves the objective open. See [Elastic Memory Study](../../TECHNICAL_REPORT.md#elastic-memory-study) and [Elastic Memory](../studies/elastic-memory.md).
- The report records no deployed measurement of `ElasticRegion`, `AsyncElasticRegion`, `sqlHolder` or `peerHolder`. Their evidence is unit tests that compare a region with a plain `Uint8Array` over 20,000 random reads and writes, a read back after a new region restores the version table, and the stale and missing chunk refusals.
- The managed page plane did not meet its gate on days 1 and 2. Dense runs failed the p90 rule, and the time model missed chase cells. See [Elastic Memory Study](../../TECHNICAL_REPORT.md#elastic-memory-study).

[Limits](../limits.md) lists the limits that cross modules.

## See Also

- The API reference for `@gmitch215/folio/memory`, generated from `src/memory.ts`.
- [Boot](boot.md) and [Continuation](continuation.md) for the other two uses of linear memory in this package.
- [Workers](workers.md) for the managed backend that copies snapshots.
- [Distributed Page Ownership and Writeback](../../TECHNICAL_REPORT.md#distributed-page-ownership-and-writeback), [Elastic Memory Study](../../TECHNICAL_REPORT.md#elastic-memory-study) and [Storage Resets and the Growth Governor](../../TECHNICAL_REPORT.md#storage-resets-and-the-growth-governor) in the technical report.
- [Elastic Memory](../studies/elastic-memory.md) and [Memory Accounting](../studies/memory-accounting.md) for the studies.
