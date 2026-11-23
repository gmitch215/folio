# Folds and Certificates

Some loops and streams are not independent in the obvious sense and still split exactly. This page
covers the tools in `@gmitch215/folio` that split them: chunked recurrences with a known combine,
certified stream folds, ownership certificates for loops of records, and the router that picks among
them. A certificate is a proof the checker derives from the module bytes. Where the checker cannot
prove a property, it refuses with a reason, and the function runs serially or on another route.

## Overview

Three cases come up.

- A **stream fold** is one function `entry(state, ptr, len)` over a byte stream, such as a CRC-32,
  an Adler-32 or an AES-CTR keystream. The update is linear or closed-form, so chunks run on
  separate workers and their end states combine into the serial result.
- A **record loop** is a function `bulk(table, count, out, ...)` that loops over records. Compiled
  drivers often write a fixed address (a scratch buffer, a static table, a cursor) before they read
  it back, and records that run on several threads over one memory collide there. An ownership
  certificate checks that the scratch is private to each record.
- The **router** takes a call description and the module bytes, tries the certified routes in a
  fixed order and says why it took the route it took.

`certifyStream` returns either a certificate or a refusal. For a CRC-32C subject built by
`scripts/research/affine-build.ts`, the certificate reads like this:

```text
{
  kind: 'certificate',
  ring: 'gf2',
  bits: 32,
  block: 4,
  layout: { entry: 'crc32c', state: 0, ptr: 1, len: 2, bits: 32 },
  zeroLength: 'identity'
}
```

An FNV-1a subject from the same builder is refused with `kind: 'refusal'`, a `reason` and one entry
in `attempts` per ring (`gf2`, `z2w`, `zp`), each saying the state passes through a product by a
constant that is not a power of two.

## Getting Started

The smallest useful call asks whether a stream function is certifiable. The module exports
`crc32c(state, ptr, len)`.

```ts
import { certifyStream, verifyCertificate } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

const bytes = readFileSync(new URL('./checksum.wasm', import.meta.url));

const certificate = certifyStream(bytes, 'crc32c');
if (certificate.kind === 'refusal') {
  console.log('serial only:', certificate.reason);
} else {
  console.log(certificate.ring, certificate.bits, verifyCertificate(bytes, certificate));
}
```

`certifyStream(bytes, entry)` takes `layout` (the parameter positions of the state, the pointer and
the length, 0, 1 and 2 by default), `block`, `maxMs` and `ring` as options. A certificate names the
module digest, and `verifyCertificate(bytes, certificate)` re-derives it from the module and returns
whether it matches. A refusal describes the checker and says nothing about the function. The next
section runs a certified fold on workers.

## Intermediate

### Chunked Recurrences

A CRC-32, an Adler-32 or an AES-CTR stream over one input is a recurrence with an exact combine, so
chunks run on separate tasks and join into the serial result. `chunkRanges(length, count, align)`
cuts the input. `foldChunks(pool, input, { task, initial, combine })` runs one task per chunk on a
[task pool](pools.md) and combines the results in order. `crc32Combine`, `adler32Combine` and
`ctrAdvance` supply the algebra. AES chunks must be multiples of 16 bytes except the last. Chunks
are copied into their tasks.

```ts
import { crc32Combine, foldChunks, TaskPool } from '@gmitch215/folio';
import { Worker } from 'node:worker_threads';

const pool = new TaskPool(8);
for (let index = 0; index < pool.size; index++) {
  const link = pool.link(index);
  // the worker calls serveTasks and answers the task `crc32` with String(crc32(input))
  new Worker(new URL('./crc-worker.js', import.meta.url), {
    workerData: { link },
    transferList: [link.port]
  });
}

const input = new Uint8Array(64 * 1024 * 1024);
// fill the input here
const crc = foldChunks(pool, input, {
  task: () => 'crc32',
  initial: 0,
  combine: (state, part, chunk) => crc32Combine(state, Number(part.text()), chunk.end - chunk.start)
});
console.log(crc.toString(16));
pool.close();
```

On one 64 MiB stream with eight task workers, CRC-32 ran 3.52x faster than serial with copied chunks
and 4.25x with shared input, the result equal to `zlib.crc32`
([Exact Chunked Recurrences](../../TECHNICAL_REPORT.md#exact-chunked-recurrences)). A recurrence
with no known combine, such as one SHA-256 message, stays serial. `foldAffine` recovers the operator
of a streaming update function by probing and folds it in exact mode, which returns the serial state
whatever the probed model says.

### Certified Stream Folds

`certifyStream` decides whether an exported function `entry(state, ptr, len)` over a byte stream is
the left fold of one affine byte step, for every length of at least one byte. The proof executes the
function symbolically, so it covers the unrolled main loop and tail that clang emits, tables the
module carries or builds on its first call, 64-bit states and internal calls. The step is affine in
the state over GF(2) (bit operations), over Z/2^w (add and multiply) or over two 16-bit residues of
one modulus (Adler-32 keeps its two sums this way), and it may apply any pure function to the input
bytes.

`guardInput` checks that an input range stays inside memory and clear of the bytes the proof read.
With a certificate, `foldCertified` runs every chunk once from state zero on its own worker, reads
the input in place from shared memory and combines the end states with the recovered model. It does
not run a second pass, because the certificate replaces the validation that `foldAffine` needs when
it only has a sampled model.

```ts
import {
  TaskPool,
  certifyStream,
  foldCertified,
  installPrefill,
  shareCertified
} from '@gmitch215/folio';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

const bytes = readFileSync(new URL('./checksum.wasm', import.meta.url));
const certificate = certifyStream(bytes, 'crc32c');
if (certificate.kind === 'refusal') throw new Error(certificate.reason);

const pages = 256;
const subject = shareCertified(bytes, certificate, pages);
const memory = new WebAssembly.Memory({ initial: pages, maximum: pages, shared: true });
installPrefill(subject, memory);
const module = new WebAssembly.Module(subject.bytes);

const pool = new TaskPool(8);
for (let index = 0; index < 8; index++) {
  const link = pool.link(index);
  // worker.ts calls serveCertified(link, { module, memory, layout }) from workerData
  new Worker(new URL('./worker.ts', import.meta.url), {
    workerData: { link, module, memory, layout: certificate.layout },
    transferList: [link.port]
  });
}

const input = new Uint8Array(memory.buffer, 1 << 20, 64 * 1024 * 1024);
// fill the input here
const { state } = foldCertified(pool, input, memory, certificate);
```

A function that also rewrites its input in place, such as a stream cipher that xors a keystream into
the buffer, gets an `output` field when the proof shows that byte i becomes a fixed function of the
original byte and the fold state before it, and that nothing else is written. When the state does
not read the input bytes, `reconstructCertified` starts every chunk at its own state, which the
model gives without running the kernel, and each worker rewrites its own bytes once. A chunk that
ends in a state the model did not predict makes it throw, because the input is already rewritten.
`foldCertified` throws for a certificate with `output`, because chunks that start from state zero
would write the wrong bytes.

A refusal describes the checker and not the function. The checker refuses a branch on input data or
on the state, a pointer or length used as data, state kept in memory or globals, stores other than
the in-place byte rewrite, imports, a start function and passive data segments. A function that
depends on the alignment of its pointer or reads past its input is refused. `zeroLength` in the
certificate says what a call over no bytes returns, and `foldCertified` runs an empty input as the
serial call.

Across ten stream subjects at eight task workers, one pass on shared memory reached 3.4x to 4.1x at
8 MiB and 4.7x to 6.8x at 64 MiB over the serial call, with process CPU at 1.02 to 1.10 of serial at
64 MiB and every result equal to the serial call
([Certified Stream Folds](../../TECHNICAL_REPORT.md#certified-stream-folds)).

### Ownership Certificates

`certifyOwnership` checks whether a function that loops over records keeps its scratch memory
private to each record. It takes an entry that is `bulk(table, count, out, ...)` by default (`entry`
and `convention` name another function and record layout), finds the fixed-address windows the
records write, and returns a certificate or a refusal. A certificate covers six obligations: state
isolation, read before write, aliasing through indirect pointers and bulk operations, the final
state the owner must rebuild, escaping addresses, and failure (a trap or aborted iteration publishes
nothing). The `prefix`, `config`, `recursion` and `allocator` options widen the domain the checker
handles, and each adds premises that the certificate lists.

A refusal carries a `reason` from the closed list `OWNERSHIP_REASONS`, the `obligation` it belongs
to, a `detail` and, where there is one, an `address`. The reasons are one per obligation
(`isolation`, `read-before-write`, `aliasing`, `final-state`, `escape`, `failure`), the pointer
rules of the allocator mode (`ptr-store`, `ptr-return`, `ptr-import`, `ptr-compare`, `ptr-control`,
`ptr-deref`, `allocator`), `prefix-store`, `prefix-cover`, `config-store`, and four about scope:
`no-window`, `unsupported`, `budget` and `invalid`. `budget` means the analysis hit its step limit
(4,000,000 by default) and says nothing about the program.

`verifyOwnership(bytes, certificate)` re-derives the certificate from the module and compares
everything except the work counters. A certificate names the module digest and the checker version
(`OWNERSHIP_CHECKER`).

Two routes run a certified driver. `ownershipSlices` redirects every window access to a private copy
per worker and runs the records in place on the slice pool. A trap in any slice puts `writes` back
and runs the calls serially in place, so the serial run decides the memory and the trap.
`ownershipSlices` throws `OwnershipSlicesError` with code `wild-store` for a certificate that
records stores no record owns. Its `run` throws the same error with code `layout` when a record
region overlaps a window, and with `config` when the memory differs from a configuration the
certificate assumed. `redirectOwnership` and `ownershipRoute` make the same rewrite and hand it to
the iteration pool, which tracks every access and paid less on the module measured.

```ts
import { certifyOwnership, ownershipSlices, verifyOwnership } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

const bytes = readFileSync(new URL('./records.wasm', import.meta.url));
const count = 128;
const table = 1024;
const input = 1 << 20;
const inputBytes = 1 << 20;
const out = 2 << 20;

const certificate = certifyOwnership(bytes, { entry: 'bulk' });
if (certificate.kind === 'refusal') {
  throw new Error(`${certificate.reason} (${certificate.obligation}): ${certificate.detail}`);
}
if (!verifyOwnership(bytes, certificate)) throw new Error('the certificate does not re-derive');

const memory = new WebAssembly.Memory({ initial: 8, maximum: 40, shared: true });
const pool = await ownershipSlices(bytes, certificate, { memory, workers: 4 });
try {
  // write the record table, the inputs and the output area into pool.memory here
  const report = await pool.run(
    count,
    (from, to) => [table + 16 * from, to - from, out + 64 * from],
    {
      regions: [
        [table, table + 16 * count],
        [input, input + inputBytes],
        [out, out + 64 * count]
      ],
      writes: [[out, out + 64 * count]]
    }
  );
  console.log(report.ownership?.replayed);
} finally {
  await pool.close();
}
```

A certificate rests on premises that the checker does not prove, and a run that breaks one can
return a different result than the serial program:

- The record regions (table, output slots, inputs, auxiliary data, arena slices and stack slots) do
  not overlap a window. `OwnershipSlices.run` checks the `regions` and `writes` the caller passes,
  so they must be complete.
- Record-derived pointers stay inside their regions. The library does not check this one.
- The entry branches on its loop counters and the record count only to end or repeat its loop.
- A trap discards the private copies and the serial path decides what happens next.
- The start function and the host leave the window bytes the private copies start from.
- The stack pointer discipline and the stack residue are not proved.

The `allocator`, `prefix` and `config` modes add their own premises, which the certificate lists in
`allocator.assumptions`, `prefix.rules` and `config.rules`. The checker produced false certificates
in three red team rounds, and each class is closed in the frozen checker (`folio-ownership-2`). On
the frozen checker, the adversary families and two generators of 20,000 modules each found no module
whose certificate was wrong. The adversary families accept the same number of modules as before the
fixes, so they do not exercise the new refusals, and the generators have blind spots. The premises
above still apply. On the 10 development drivers that fail the plain slice pool, 6 certify
([Ownership Certificate and the Slice Route](../../TECHNICAL_REPORT.md#ownership-certificate-and-the-slice-route)).

### The Router

`Router` picks one route for a call from the module bytes and a description of the call, runs it and
says why. A call is `{ kind: 'stream', entry, ptr, len }` for one function `entry(state, ptr, len)`
over a byte stream, or `{ kind: 'records', entry, count, args, regions, writes }` for a loop of
independent calls, where `args(from, to)` returns the arguments of a slice.
`Router.open(bytes, call, options)` decides and builds the memory and pools its route needs, and
`router.run()` executes the call. `decide(bytes, call, options)` returns the decision without
running anything. A parallel route over a records call needs a module that imports its memory, which
the router allocates shared.

The order is fixed. A stream takes the certified summary when `certifyStream` returns a certificate.
A loop of records takes the certified window when the ownership certificate exists, records no wild
stores and the regions clear its windows. After that comes the explicit runner in `options.explicit`
if the caller supplied one, then tracked speculation, then serial. Tracked speculation runs only
after an ownership refusal for allocator state or a missing window, and only when `assume` states
that imports are deterministic (or absent) and that nothing reads the stack zone afterwards.

`mode` limits the routes. `router` is the whole chain, `serial` never leaves the owner, `w1` is the
summary only and `w2` the window only, and `independent` and `shared` try the summary and then the
window, with the module analyses made independently or shared. The last four are the arms of the
development ablation.

Certificates and refusals go into a `CertificateCache`, keyed by the module's SHA-256 and by the
backend, the checker versions, `ROUTER_VERSION` (`folio-router-2`) and the options that change a
certificate. A refused module costs a map lookup after the first call, and `serialize()` and
`load()` move the cache between processes. A route has a floor: the window route stays serial below
0.8 ms of remaining serial work and the summary route below 1 MiB, both in `routerConstants`, and
the tracked and explicit routes use the admission floor of the iteration route. The router runs the
first records of a call serially to estimate that time, and it stops dispatching after two losing
dispatches in a row. The constants were fitted on development data, so a result on the development
drivers describes the fit. The figure on the frozen final corpus is in [Limits](../limits.md).

```ts
import { Router } from '@gmitch215/folio';
import { readFileSync } from 'node:fs';

const bytes = readFileSync(new URL('./records.wasm', import.meta.url));
const count = 128;
const table = 1024;
const input = 1 << 20;
const inputBytes = 1 << 20;
const out = 2 << 20;

const router = await Router.open(
  bytes,
  {
    kind: 'records',
    entry: 'bulk',
    count,
    args: (from, to) => [table + 16 * from, to - from, out + 64 * from],
    regions: [
      [table, table + 16 * count],
      [input, input + inputBytes],
      [out, out + 64 * count]
    ],
    writes: [[out, out + 64 * count]]
  },
  { mode: 'router', pages: 8, maxPages: 40, workers: 4 }
);
try {
  console.log(router.decision.route, router.decision.reason, router.decision.detail);
  for (const step of router.decision.considered) {
    console.log(step.route, step.verdict, step.reason);
  }
  // write the record table, the inputs and the output area into router.memory here
  const run = await router.run();
  console.log(run.route, run.reason, run.wallMs);
} finally {
  await router.close();
}
```

A refusal is a decision with `route: 'serial'` and a `reason` from the closed list `ROUTER_REASONS`.
The first four reasons are routes taken (`certified-summary`, `certified-window`, `explicit-runner`,
`tracked-eligible`) and the rest are refusals, such as `allocator-state`, `shared-state`,
`wild-store`, `layout-overlap`, `assumption-unasserted`, `memory-not-imported` and `below-floor`.
`decision.considered` lists each route in the order the router looked at it, with a `verdict` of
`taken`, `refused` or `skipped`, its reason and a `detail` that quotes the certifier's refusal.
`decision.cacheHit` and `certifyMs` say whether the analysis was paid for on this call. The `route`
that `run()` returns is the route that executed, which differs from the decision when a floor sends
the call to the owner (`below-floor`) or the loss rule stops a dispatch (`dispatch-lost`).

## Limits

- The stream certifier proves GF(2), Z/2^w and two-residue folds and an in-place byte rewrite.
  Blocked checksums (zlib's Adler-32), state held in linear memory, imports and writes that do not
  read the byte are outside it, and a refusal says nothing about the function
  ([Certified Stream Folds](../../TECHNICAL_REPORT.md#certified-stream-folds)).
- A stream certificate is evidence from a checker with no formal verification. Two adversary rounds
  and two code reviews each found a false certificate, all fixed, and the reviewers share the
  author's model family
  ([Independent Verifier and Fourth Adversary Round](../../TECHNICAL_REPORT.md#independent-verifier-and-fourth-adversary-round)).
- Six of 10 development drivers certify for the ownership route against a locked line of 8. On the
  frozen final corpus of 47 drivers, 1 certifies
  ([Ownership Certificate and the Slice Route](../../TECHNICAL_REPORT.md#ownership-certificate-and-the-slice-route)).
- The router's geometric mean on the final corpus is 0.899 on x86_64 and 0.900 on arm64 against
  1.20, and it ran serial on 46 of 47 drivers
  ([Router and Development Ablation](../../TECHNICAL_REPORT.md#router-and-development-ablation)).
- A recurrence with no known combine, such as one SHA-256 message or a single long xxHash stream,
  stays serial ([Architectural Boundaries](../../TECHNICAL_REPORT.md#architectural-boundaries)).

[Limits](../limits.md) groups every module's limits in one place.

## See Also

- API reference: [certifyStream](https://folio.gmitch215.dev/functions/index.certifyStream.html),
  [certifyOwnership](https://folio.gmitch215.dev/functions/index.certifyOwnership.html) and
  [Router](https://folio.gmitch215.dev/classes/index.Router.html).
- Report: [Certified Stream Folds](../../TECHNICAL_REPORT.md#certified-stream-folds),
  [Ownership Certificate and the Slice Route](../../TECHNICAL_REPORT.md#ownership-certificate-and-the-slice-route)
  and [Router and Development Ablation](../../TECHNICAL_REPORT.md#router-and-development-ablation).
- Studies: [Parallel Execution](../studies/parallel-execution.md).
- Back to [Pools](pools.md) for the slice pool these routes run on.
