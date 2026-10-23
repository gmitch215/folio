# Managed Cloudflare Probe

`worker.ts` separates four mechanisms: same-isolate structured clone, local MessageChannel,
RPC to a Durable Object, and CPU fan-out to distinct object IDs. Module UUIDs identify isolates;
object IDs alone do not establish separate isolates. Every CPU row records both identities.

The Wasm atomic control imports `build/sharing.wasm`, compiled by the existing freestanding C
toolchain. It does not construct or compile Wasm bytes during a request.

## Deployment

`deploy.ts` owns deployment and cleanup. It uses one temporary `cfw-folio-<random>` script on the
authorized account named by `FOLIO_CLOUDFLARE_*` or `FREE_CLOUDFLARE_*`. Map the account's existing environment variables to
`CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` without printing values. Wrangler reads the
account from the environment; the checked-in config contains no account or credential.

Snapshot the account's Worker script IDs and Durable Object namespace IDs before deployment.
The read-only API routes are `/accounts/{account}/workers/scripts` and
`/accounts/{account}/workers/durable_objects/namespaces`. Also read
`/accounts/{account}/workers/subdomain` to construct the temporary URL. Retain the baseline and
post-cleanup IDs, not authorization headers. Keep existing resources out of cleanup.

`node experiments/deploy.ts cloud` deploys with the repository's Wrangler, using
`--config experiments/cloud/wrangler.jsonc` and the temporary name. It starts a JSON tail for that
script before it calls `collect()` in `run.ts`. Tail records associate lane CPU metrics with the
nonce, round and lane count, and `analyze-tail.ts` joins them to the result afterwards. The driver
refuses to overwrite an output file, and `node experiments/cleanup.ts NAME cloud` recovers a run
that died before cleanup.

The driver makes three external HTTP requests. The complete run issues at most 57 Worker/DO
invocations: 3 external, 8 capability RPC attempts, 1 coordinator call and 45 lane calls. There
are no storage calls, alarms, retry loops or durable writes. User allocations stay below 1 MiB
per isolate. The CPU kernel has at most 1,048,576 indices and 256 xorshift rounds per index; its
default uses half those bounds. On the selected free account this consumes request and duration
allowance; it creates no paid-plan activation. Do not run against the default paid environment.
The current [DO pricing table](https://developers.cloudflare.com/durable-objects/platform/pricing/)
includes 100,000 requests and 13,000 GB-s per day on Free. Thus this run reserves at most 57
request units, with $0 in metered charges on that plan; exhaustion rejects requests. Each stub
method is a billed RPC session. Duration bills a fixed 128 MB per active object even when actual
allocations are smaller. Snapshot usage first because another task can consume the same quota.

The CPU matrix runs K=1/2/4/8 in alternating order, discards the first round and retains two
measured rounds. Every partition checksum must equal the serial K=1 result, and its exact range
must cover the same whole workload. This is a capability control with a small sample count.
Any speed claim must retain its two observations and observed isolate count.

Workers [freeze clocks while JavaScript runs](https://developers.cloudflare.com/workers/runtime-apis/performance/).
The coordinator's elapsed timer spans awaited RPC,
so it measures end-to-end fan-out wall time. A lane timer is not a CPU meter. To establish a
CPU-overlap lower bound, sum platform lane CPU time for a matching row and divide by its
coordinator span. All matching lane events occur inside that span by causality; cross-machine
timestamps are unnecessary. Without per-event CPU metrics, report wall scaling and identity
only. Do not substitute JavaScript iteration counts for CPU milliseconds.

Check request/duration usage during this bounded run through the account analytics API or
dashboard. Verify the selected account is free before the first invocation. Capture the same
usage window afterward. There are no application SQL operations to multiply with lane count.
The coordinator must tear down the temporary script and its two new namespaces immediately
after the run, then compare script and namespace IDs with the baseline.

## Assertions

The ordinary RPC control requires 17 at the recipient, 29 after recipient mutation, 29 in the
returned bytes, and 17 still at the caller. A shared-memory argument succeeds only if a recipient
in a different module UUID changes the caller's bytes without a returned payload. Shared return
values are attempted separately. A local clone's bidirectional write visibility establishes
aliasing within its existing isolate; it does not establish another execution agent.

The local workerd run passed the ordinary byte and bundled atomic controls. SAB and shared
Memory clones showed bidirectional visibility. MessageChannel rejected SAB with
`SharedArrayBuffer is unsupported with MessagePort`; RPC rejected SAB and shared Memory in both
directions. Non-shared Memory and MessagePort RPC also failed. The eight local objects shared
one module UUID, so this local run establishes co-residency without CPU parallelism. Raw output:
`results-local.json`. The local Miniflare instance stopped in `finally`.

## Host Workarounds

The relevant current upstream source was read as full functions, not search excerpts:

- [RPC serializer](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/worker-rpc.c++):
  `serializeJsValue()` keeps `released.data`; `deserializeJsValue()` receives no transferred or
  shared backing-store array. Thus a locally valid shared handle has no recipient binding.
- [JSG serializer](https://github.com/cloudflare/workerd/blob/main/src/workerd/jsg/ser.c++):
  shared clones retain `std::shared_ptr<v8::BackingStore>` and create a new SAB wrapper over that
  store. This supplies the native building block for a host-local arena channel.
- [MessageChannel implementation](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/messagechannel.c++):
  `postMessage()` explicitly rejects shared backing stores, even for local delivery.
- [Node worker threads shim](https://github.com/cloudflare/workerd/blob/main/src/node/worker_threads.ts):
  constructing `Worker` throws; the exported name does not create an execution agent.

A self-hosted workerd extension can retain an arena's backing-store handle in a process-local
registry, mint an opaque tenant-scoped capability, and reconstruct shared Wasm memories inside
multiple separately scheduled isolates. It must implement lifetime, bounds, memory accounting,
growth coordination, resource limits and cancellation. A capability is meaningful only inside
that host process; exporting its identifier over a network does not export RAM.

The existing Folio Node backend supplies this execution host now. Managed Workers can route a
whole job to it and stream the response. Physical zero-copy applies between that host's
participating isolates; the edge-to-host request crosses a transport boundary. Another option
is provider support for a same-process arena binding and execution group. Managed JavaScript
cannot implement the missing backing-store registry through the tested RPC interface.

## Implemented Execution Host

`src/remote.ts` supplies the portable `RemoteFolio` client; `src/host.ts` supplies
the Node `FolioHost` fetch handler. The host registers trusted artifacts and
bindings, authorizes requests, and creates real shared-memory worker groups.
Session capabilities, monotonic sequences and an exact duplicate-response cache
prevent an explicitly retried lost response from replaying accepted effects.
The bounded cache is in memory; no durable restart guarantee is provided.

Run `node experiments/cloud/host-probe.ts [RESULT_JSON]`. Miniflare comes from the repository's
Wrangler dependency, and no deployment is performed. The probe runs the actual portable module in stock workerd with
a service binding to the Node host, compares all 131072 bytes against native C,
checks four worker threads plus exact BigInt/void results, and joins both group
disposals and Miniflare shutdown. `results-host-20261020.json` retains the final
run; the earlier local/v2/final records remain separately.

The edge-to-host request and result are serialized. Shared physical backing is
inside the host group. A public managed Worker-to-host endpoint and network
latency are separate deployment checks. Host memory admission checks initial
accessible canonical backing; trusted artifact factories enforce growth maxima
and reserve snapshot/private overhead. It is not a V8 heap quota.

DO fan-out remains a route to aggregate CPU with distributed data ownership. Page messages,
remote loads, streams, content-addressed blobs and replicated state do not become physical
shared memory through an API name. Co-resident DO globals share one isolate's resources and
serialize CPU execution.

The [RPC documentation](https://developers.cloudflare.com/workers/runtime-apis/rpc/) describes
supported value types and asynchronous capabilities. The
[MessageChannel documentation](https://developers.cloudflare.com/workers/runtime-apis/messagechannel/)
limits ports to one Worker instance and excludes RPC port transfer. The
[DO memory documentation](https://developers.cloudflare.com/durable-objects/reference/in-memory-state/)
allows multiple instances to share globals and accounts memory per isolate. These full relevant
sections were read on 2026-10-19; a deployed result takes precedence over an inferred exclusion.
