# Consumer Harness on a FREE Backend

`harness.ts` runs in Chromium under Browser Run. For each consumer it opens one native instance and
one `BrowserFolio` per width on fresh private memories, then runs rounds that rotate the arm order.
Every sample compares the whole memory and the return values with the native arm of the same round. A
two-lane word hash covers every sample and a SHA-256 covers round 0 of each arm. A mismatch stops the
run and keeps the rows.

## Arms and Consumers

| consumer         | module                                             | arms                  | cases                                |
| ---------------- | -------------------------------------------------- | --------------------- | ------------------------------------ |
| `kernel-control` | `build/fixture.wasm`, counted loop `program`       | native, 2, 4, 8 lanes | one, 67 words x 524,288 rounds       |
| `gmux-abi`       | `gmux/build/probes/abi.wasm`, 64 MiB shared memory | native, Folio         | memset, memcpy, chain of 16 MiB      |
| `tinyimg`        | `c-c++/tinyimg/dist/tinyimg.wasm`                  | native, Folio         | 13 operations on a 1024 x 1024 image |

The consumer modules are read from the sibling checkouts and are never edited. `prepare.ts` runs the
compiler's `prepare()` on each module and ships only the trusted loop metadata and the original bytes.
The browser path applies `BrowserFolio`'s own `minimumParallelWork`; the static admission rule of
`extract.ts` is not in this path. The gmux ABI and tinyimg have no counted-loop plan, so Folio runs
them through `run()` on the original exports.

## What Is Reported

Wall time from `performance.now()`, the dispatch report (workers, regions, mode, reason), lane run
messages and the JSON bytes they carried, and the paired speedup per round. CPU is not reported: a page
has no process CPU. A session stops starting new cases after its time budget and reports the pairs it
completed.

## Meter and Safety

The Worker asks `history()` for today's sessions before every launch and refuses past the Free allowance.
`deploy.ts` snapshots Workers, Durable Object namespaces, KV, R2 and D1 first, deploys under a
temporary name, runs the sessions 22 s apart (Free allows a new browser every 20 s), deletes the Worker
and fails unless the account equals the baseline.

## PHP

`php/worker.ts` boots the original `php8.5.tuned.wasm` through the consumer's glue in a plain Worker
handler and in a SQLite-backed Durable Object, runs a SHA-256 chain whose output Node recomputes, and
streams a memory plateau (JS buffers, then PHP strings) until the isolate is reset. `php/prepared.ts`
adds the 31.2 MB coordinator, the 4.8 MB worker module and the 8.5 MB tracked module of the old prepared
set and instantiates each with stub imports. CPU and outcome come from `wrangler tail`.

Documentation read 2026-10-20: Workers limits, Workers pricing, Durable Object limits, the WebAssembly
runtime page, Browser Run limits and pricing, all under developers.cloudflare.com.
