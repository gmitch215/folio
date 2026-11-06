# Managed Envelope

Question: can the dense 192 MiB fixture complete on the Cloudflare Free managed plan, with a 64 KiB executor memory and bounded continuation quanta?

Result: it completes exactly. The run performed 15,360 page operations across 961 executor segments and 960 handoffs, and every page verified. The execution HTTP timers sum to 392.268 s, or 25.5 ms per page operation, in one run. The runner took 422.733 s including deployment, readiness and cleanup.

## Design

- A static Wasm module, unchanged from the local fixture, fills 3,072 logical 64 KiB pages and follows a dependent pointer chain.
- Four SQLite-backed page-owner Durable Objects hold the page bytes. Each owner has a one-page application cache.
- Two executor Durable Objects alternate. Each segment runs 16 page operations, then returns a 64 KiB checkpoint. The client starts a fresh top-level request with it.
- This is the remote owner, no executor cache design. Every load and store is a subrequest to a page owner, and every store is an awaited whole-page put. It has no frame cache in the executor. It is not evidence for the four-frame local design.

## Results

| Measurement                                              |          Observed |
| -------------------------------------------------------- | ----------------: |
| Logical bytes initialized and verified                   |       201,326,592 |
| Physical executor Wasm bytes, every segment              |            65,536 |
| Executor segments / handoffs                             |         961 / 960 |
| Page operations / operations per quantum                 |       15,360 / 16 |
| Executor DO objects / page-owner DO objects              |             2 / 4 |
| HTTP attempts, including readiness and cleanup           |               971 |
| Page puts / logical pages deleted during cleanup         |     9,216 / 3,072 |
| Continuation payload, request and response combined      | 125,829,120 bytes |
| Runner wall, including deployment, readiness and cleanup |         422.733 s |
| Sum of execution HTTP timers, response headers only      |         392.268 s |

Decision: the managed run completes, 25.5 ms per operation, one run. This is a capacity result. It makes no claim about any real workload and no claim that the fixture's latency is acceptable.

## Platform memory and CPU

Role namespaces, from the Durable Objects periodic groups (`metrics-do-final.json`):

| Role namespace | Maximum reported memory sample | Median memory sample | Reported CPU |
| -------------- | -----------------------------: | -------------------: | -----------: |
| Executor       |     4,771,892 bytes (4.55 MiB) |      2,380,472 bytes |   6.587069 s |
| PageOwner      |   26,421,476 bytes (25.20 MiB) |     12,986,596 bytes |  11.259311 s |

Both namespaces report zero exceeded-CPU and exceeded-memory errors. These are sampled whole-isolate samples per namespace. They are not absolute peaks, and two executor objects and four owner objects do not prove six V8 isolates. The second poll (`metrics-do-settled.json`) returns the same CPU, memory and row totals. Earlier empty and partially ingested polls are kept, so absence is not read as zero usage.

## Failures and cleanup

- **First run (`first-run/`).** The first deployment completed one segment and then saw a propagation 404 on readiness. Its cleanup recorded the new script as a difference (`ownResourcesRestored: false`). `first-run/cleanup-later.json` shows the inventory returned to baseline on a later check.
- **Final run.** Readiness 404s were retried against the same deterministic operation, and every execution request succeeded. All four owner stores were cleared, both classes retired and the Worker deleted. `cleanup.json` reports `ownResourcesRestored: true`.

Cleanup billing accounting is not reconciled with the logical row counts. The platform meter is the reference, and the logical counts do not replace it.

## Scope

- One static fixture, not PHP, arbitrary Wasm, or physical shared memory.
- Client-driven continuation: a fresh top-level request every 16 operations. The run does not show an unbounded chain inside one request.
- Fixture supports aligned i32 loads and stores and whole-page fill only.
- The single logical size does not establish an asymptotic memory bound.
- Object identifiers are not isolate identities. The records keep no account identifiers.

See [METHOD.md](METHOD.md) for the procedure, limits and caps.
