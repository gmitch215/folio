# Managed Coherent Execution

The portable `ManagedFolio` runtime instantiates precompiled source and
coordinator modules. The original Wasm stack owns control flow, scalar results,
opaque state and host effects. JSPI joins compiler-discovered regions across
named Durable Object lanes. `FolioLane` runs the precompiled tracked closure
against an independent frozen snapshot and returns binary byte read/write sets.
There is no Node execution host, request-time compilation or RPC per memory
access. The binary protocol uses bounded metadata and byte payloads; it carries
neither native shared-memory objects nor executable host bindings.

All lanes settle before canonical commits. Existing ordered validation/replay
preserves dependencies and trap prefixes. Missing or malformed lane replies
discard copied speculative work and use the original native region at the
owner. Lost completed lane replies can repeat pure private computation without
repeating owner host effects. Engine resource failures in an optimization retain
native fallback. Concurrent runs are refused; close joins active execution and
attempts every lane's disposer even if one fails.

This implementation copies one complete canonical snapshot per lane batch. It
does not yet have distributed page owners or region footprint leases. The
canonical native memory must fit the owner runtime, and lane snapshots, encoded
frames and private logs must fit each lane. Limits bound snapshots, frames,
tracking and fuel. Copy counters count explicit snapshot bytes and wire frame
bytes; the platform does not expose every internal serializer copy. This backend
does not merge managed isolate memory quotas. Browser Run is measured separately
for a shared 256 MiB native arena.

## Probe

`prepare.ts` runs the existing compiler offline and emits static Wasm modules
and metadata under `build/`, then a deployment entry in `artifact.ts`. The
unannotated, normally inlined 511-byte C module is the same source artifact as
the Node generalized measurement. Its entry has scalar results, branches and
64 discovered dynamic regions. The Worker never compiles these bytes at request
time.

`worker.ts` compares batched ordinary-byte RPC, binary fetch, streamed binary
fetch and persistent binary WebSockets at 2/4/8 lanes. Every arm gets one warmup
and two measured runs, with all 39 rows retained. Serial native execution runs
through the same owner object and caller RPC boundary. One round count is used
for every arm. Expected results are computed during preparation outside the
local matrix's timed invocation, and each row compares the scalar result and all 131072 bytes.
The final deployed driver prepares and executes each row inside one active
owner invocation. Its outer wall time includes initialization, lane admission,
the serial expected-result oracle and close. It measures end-to-end work with
those costs, not isolated kernel speed. An earlier deployed attempt reached
three exact serial rows and then found no prepared pool on a later RPC;
`runPrepared` removes that cross-invocation retention assumption. The earlier
failure and route-propagation 404 remain in their own cleaned-up run directories.

The outer Worker's clock spans awaited owner RPC; timers inside a synchronous
Wasm lane are not CPU meters. Each response records module UUIDs and object IDs
separately. Tail events record session, epoch and sequence for matching platform
CPU telemetry where available. A named object may share its isolate with other
objects. No CPU count is inferred from the number of object IDs.

Public execution requires `PROBE_TOKEN`. The deployment
driver uses only the FREE or STUDENT credentials, snapshots existing scripts/namespaces,
and removes its own classes and script before comparing the account baseline.
The fixed matrix allows at most 640 lane invocations and 700 total invocations,
with no application SQL reads/writes. Each body is capped at 2 MiB in this probe;
the library has its own frame, memory and tracking bounds. A public endpoint is
temporary and is removed immediately after measurement.

## Reproduction

From the Folio root:

```sh
bun run build:c
node experiments/managed/prepare.ts
node experiments/managed/local.ts [RESULT_JSON]
node experiments/deploy.ts managed
node experiments/managed/analyze.ts RESULT_JSON [SUMMARY_JSON]
```

`local.ts` bundles the Worker with a Wrangler dry run and drives it in local workerd through
Miniflare. `deploy.ts` reads `FREE_CLOUDFLARE_ACCOUNT_ID` and `FREE_CLOUDFLARE_API_TOKEN`, falls
back to `STUDENT_*`, and never selects another account. `FOLIO_WRANGLER` overrides the Wrangler
entry. Local workerd results are labelled local; deployed rows and cleanup records stay in their
own run directory. `node experiments/cleanup.ts NAME managed` recovers a run whose driver died
before its own cleanup. In-memory owner state is not a durable checkpoint across eviction or host
restart; the consumer owns that recovery.
