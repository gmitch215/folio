# Managed Phase Method

The precompiled 511-byte generalized C fixture runs 64 regions with 2,097,152 mixing rounds.
Every completed operation compares its scalar return and the entire canonical memory against a
native oracle. Defaults and frame/snapshot limits are unchanged. The final cohort uses 128 KiB
and 8 MiB memories, widths two/eight, and native/automatic arms. Each fresh owner performs setup,
four operations, a 16-copy frame diagnostic, an echo fanout and close. Setup includes a serial
oracle. The first operation is first pool use; three further operations reuse the same pool.
These are kernel controls, not independent application corpus results.

The final driver waits 60 seconds after starting tail before creating measured owners. It invokes
operations directly inside one owner invocation. Per-instance nonces, module UUIDs and object IDs
remain equal within each four-operation cohort. A module UUID is not a native isolate identifier.
Earlier separate-request, held-entry and self-RPC attempts retain every state-loss failure. Their
original error text says "evicted"; that text does not establish eviction. Platform replacement,
eviction and routing need separate evidence. Cloudflare documents that enabling tail can replace
instances and that code updates propagate asynchronously in its
[known issues](https://developers.cloudflare.com/durable-objects/platform/known-issues/).

External wall time spans the complete instrumented lifecycle. Managed `performance.now()` values
span awaited I/O; synchronous native work can report zero. A zero is not a CPU observation. Tail
provides whole-millisecond CPU/wall values per event. The analyzer deduplicates event IDs and
refuses to assign one shared owner event's CPU to each of its operation logs. Missing events make
aggregate CPU null. The final cohort has complete CPU telemetry for one of eight cells. Its
remaining tail sums cannot establish aggregate CPU ratios. A subsequent read-only
[Observability API query](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)
returned 449 stored records. `stored.ts` joins logs to invocation metrics by request identity and
recovers all 192 expected invocation events across the eight final cells. Each cell's aggregate CPU
is then complete; `stored.json` preserves those deduplicated observations. Initialization, validation, replay
and teardown have event/counter evidence; the final run does not isolate each one's CPU cost.
Successful automatic operations have no transport fallback or replay. No injected conflict,
forced eviction, 32 MiB snapshot, platform cold-start or paid billing experiment was performed.

The diagnostic frame/echo arms quantify explicit bytes and API calls, including their overhead.
They do not reveal internal platform serializer copies. The lifecycle ratio includes those
diagnostics and the native oracle. It is not a steady-state application speedup. The original
matrix covers widths 1/2/4/8 and memories 128 KiB/2 MiB/8 MiB, with state-loss failures retained.

Current [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) assigns
one request to an RPC method session and bills active duration at 128 MB per object, including
co-located objects. Paid overage unit rates are $0.15/million requests and $12.50/million GB-s.
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) adds $0.30/million
inbound requests and $0.02/million CPU milliseconds after included allocations. Rates were checked
2026-10-29. The result's request-rate equivalent excludes allocations, rounding, Worker CPU and
duration. It is not a bill. Account usage snapshots are lagged and include other traffic. The
observed request-duration proxy uses DO event wall time times 0.128 GB; it is not measured billed
duration. The study used the Free account, changed no plans and made no application SQL calls.

For reproduction, build fixtures, prepare managed artifacts and run the commands in README.md.
The driver saves source files/digests, an ignored frozen source archive, environment, all rows,
tail, usage snapshots and before/after inventories. Analyze to an unused role to avoid overwriting
evidence. The `FOLIO_PHASE_ENTRY` diagnostic selector accepts `separate`, `held`, `reentrant` and `measure`;
the default uses direct calls. `measure` runs one invocation per cell with a counted number of
operations (0, 1 and 5), no diagnostics and no echo, so that first-use and later-operation costs come
from differences between counts; `measure.ts` joins stored invocation CPU to those cells. `FOLIO_PHASE_PAGES` and `FOLIO_PHASE_WIDTHS` select matrix cells.
