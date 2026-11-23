# Elastic Memory

Elastic memory asks whether a Wasm guest whose linear memory exceeds the platform's memory meter can run on pages held elsewhere. This page covers the studies of paging, the cost of translating every memory access, and the mechanisms that each closed.

## Question

Can a guest address a logical heap larger than one isolate's memory while the executor keeps a small fixed amount of Wasm memory, and can that run at a cost close to the unpaged guest?

## Instruments

| Study                                                                                                                             | Question                                                               | Instrument                                   |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| [capacity-local](https://github.com/gmitch215/folio/blob/master/results/execution/elastic-memory/capacity-local/README.md)        | Does a 192 MiB to 2 GiB logical heap run exactly in 327,680 Wasm bytes | `scripts/probe/elastic/run.ts`, local        |
| [managed-envelope](https://github.com/gmitch215/folio/blob/master/results/execution/elastic-memory/managed-envelope/README.md)    | Does the 192 MiB fixture complete on the Free managed plan             | `experiments/elastic`, one live run          |
| [platform-ladder](https://github.com/gmitch215/folio/blob/master/results/execution/platform-ladder/README.md)                     | What do hops, writes, stub calls and the memory meter cost             | `experiments/elastic-limits`, Free plan      |
| [elastic-ladder-free-days](https://github.com/gmitch215/folio/blob/master/results/execution/elastic-ladder-free-days/README.md)   | Does one object run the dense fixture with pages in its own SQLite     | `experiments/elastic-ladder`, Free plan      |
| [translation-tax](https://github.com/gmitch215/folio/blob/master/results/execution/translation-tax/README.md)                     | What does software translation of every access cost on PHP renders     | `scripts/research/elastic-translate.ts`, Mac |
| [translation-tau-rig](https://github.com/gmitch215/folio/blob/master/results/execution/translation-tau-rig/README.md)             | The same on a quiet machine, with idealized bounds                     | the same arms, Ryzen 9 9900X container       |
| [translation-check-elision](https://github.com/gmitch215/folio/blob/master/results/execution/translation-check-elision/README.md) | Does removing provably redundant checks lower tau                      | the same arms                                |
| [guard-count](https://github.com/gmitch215/folio/blob/master/results/execution/guard-count/README.md)                             | How many guards would an epoch design pay per access                   | an instrumented PHP module, Node 26          |

The PHP workloads are Drupal renders: the stock front page, and the login, admin and flush routes of Thunder, a Drupal distribution. Tau is the translated render over the native render minus one. The gate was a median tau of at most 1 on each PHP render route at default V8 tiering.

## Design

The elastic design keeps a small executor memory and a set of 64 KiB pages elsewhere. The managed envelope used four page-owner Durable Objects, each with a one-page cache, and two alternating executor objects. Each segment ran 16 page operations, then returned a 64 KiB checkpoint, and the client started the next top-level request with it. The ladder variants keep the pages in the object's own SQLite.

| Variant | Resident frames | Pool in front of storage | Row size |
| ------- | --------------- | ------------------------ | -------- |
| V4      | 64              | none                     | 64 KiB   |
| V6      | 64              | 1,024 pages, compressed  | 64 KiB   |
| Unpaged | every page      | none                     | none     |

The translation arms differ in which accesses carry a check. `bcd` exempts shadow-stack and constant-address accesses, hoists invariant lookups and inlines one lookup per remaining access. `r-all` is an idealized bound in which every access is in range and costs one range test, so it cannot be built. The arms `csite` and `cfn` cache the lookup per site and per function. `r-stack`, `r-heap8` and `r-heap32` use a range check on the stack, or on a heap prefix of 8 MiB or 32 MiB.

## Results

### Capacity

| Logical size | Executor Wasm bytes | Result |
| -----------: | ------------------: | ------ |
|      192 MiB |             327,680 | exact  |
|      512 MiB |             327,680 | exact  |
|    1,024 MiB |             327,680 | exact  |
|    2,048 MiB |             327,680 | exact  |

The full scan fetched 32,768 pages (2,147,483,648 bytes) with 327,680 Wasm bytes (four data frames and one control page), and returned the independently computed checksum. The native differential compared 738,197,504 bytes at 192 MiB and 512 MiB. This is one machine with Node workers and file-backed page versions, with aligned i32 accesses and one trusted writer ([capacity-local](https://github.com/gmitch215/folio/blob/master/results/execution/elastic-memory/capacity-local/README.md)).

On the Free managed plan the dense 192 MiB fixture completed exactly in one run: 15,360 page operations across 961 executor segments and 960 handoffs, every page verified. The execution timers sum to 392.268 s, or 25.5 ms per page operation. That run had no executor cache, so every load and store was a subrequest to a page owner.

### Platform Costs

| Measure                                   | Result                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| Awaited against unawaited `put`           | no extra cost; the durable cost shows once per request that wrote         |
| Hop between objects                       | median 7 ms over RPC and 10 ms over `fetch`, 3 ms to an object's own stub |
| Colocated 64 KiB read-modify-write cycle  | 0.07 to 0.40 ms                                                           |
| Stub calls in one invocation              | 1,000 succeed and the 1,001st fails                                       |
| 10 ms CPU cap on a Durable Object request | none in the range tested                                                  |
| Linear memory on the meter                | 1.00 MiB per MiB, touched or not                                          |

All platform rows are one account, one colo and one day, with the repeat counts in the [platform-ladder](https://github.com/gmitch215/folio/blob/master/results/execution/platform-ladder/README.md) README.

### The Page Plane on One Object

Day 1 (UTC 10 November) had ten completed runs, all in colo IAD, and every checksum and byte was exact. Dense wall times were 5,068 ms, 2,666 ms and 2,612 ms for V4 and 2,495 ms, 3,372 ms and 2,914 ms for V6. Four attempts failed: three first-attempt `init` calls returned an edge HTML 404 or 500 right after readiness, and one `run` call returned after 1,012,567 ms against a 150 s abort, for a cause that is not found. Day 2 (UTC 11 November) read V4 dense at 2,543 ms and 3,638 ms and V6 dense at 3,749 ms and 3,067 ms, all exact.

The gate rules were fixed before day 2: a dense run under 10 s at p90 with failed attempts counted as over, an unpaged comparison within 2x for a request that fits, and a time model within 20% on every cell.

| Gate measure                       | Result                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Dense p90 under 10 s               | fails: the day 1 failed attempts count as over, though every completed dense run took at most 5.1 s                           |
| Unpaged against paged at 768 pages | 126.4 ms against 736.3 ms for V4 with 768 frames (5.8x, one pair, different colos), and 978.3 ms for V4 with 64 frames (7.7x) |
| Time model within 20%              | over-predicts chase on V4 by 126.6% (3,587.6 ms predicted, 1,582.9 measured) and on V6 by 22.3%                               |

G-E2 is NOT MET on days 1 and 2. A day 3 with a model fitted on both days was pre-registered on the Free plan and not run, so the gate stays open. A supplementary day 3 on a Paid account, not the pre-registered run, read Model C within 20% on 0 of 2 V4 cells and 3 of 6 V6 cells, dense V6 walls of 3,601 ms, 3,137 ms and 5,625 ms with one failed attempt, and a 768-page pair of 930.2 ms for V4 against 162.3 ms unpaged (5.7x). That run neither closes nor unblocks the gate, and its raw rows are not exported.

### Translating Every Access

| Route          | `bcd` | `csite` | `cfn` | `r-stack` | `r-heap8` | `r-heap32` | `r-all` |
| -------------- | ----: | ------: | ----: | --------: | --------: | ---------: | ------: |
| Stock front    | 1.581 |   1.817 | 1.709 |     1.674 |     1.516 |      1.396 |   1.111 |
| Thunder login  | 1.287 |   1.601 | 1.481 |     1.361 |     1.286 |      1.091 |   1.023 |
| Thunder admin  | 1.088 |   1.183 | 1.074 |     1.054 |     0.883 |      0.844 |   0.542 |
| Thunder ladder | 1.184 |   1.294 | 1.188 |     1.172 |     0.910 |      0.806 |   0.526 |
| Stock flush    | 1.155 |   1.090 | 1.061 |     1.125 |     0.855 |      0.831 |   0.479 |

Ten pairs per cell on a quiet Ryzen 9 9900X container, and every arm's normalized HTML equals native. The interval of `bcd` on the front is 1.537 to 1.617. The flush route returns no HTML and is not gated. The idealized `r-all` reads 1.111 on the front, so a perfect hit rate that keeps a per-access range test cannot reach tau 1 on the stock front ([translation-tau-rig](https://github.com/gmitch215/folio/blob/master/results/execution/translation-tau-rig/README.md)).

On the Mac the full path costs a tau of 1.578 on the first uncached stock front render (4 pairs, range 1.122 to 1.751). Translating every access costs 3.43, exempting stack and static addresses 1.34, hoisting invariant lookups 1.28, and the module rewritten with no translation 0.01. Hoisting removed 16 of 1,907,990,706 dynamic accesses, and the stack and static classes are 61.6% of dynamic accesses.

Request length does not rescue it. On the Thunder ladder at default tiering tau is 1.188 at 2.4 s native, 1.357 at 7.7 s, 1.197 at 9.6 s and 1.178 at 11.0 s ([translation-tax](https://github.com/gmitch215/folio/blob/master/results/execution/translation-tax/README.md)).

The optimizing-tier arm reads tau 0.874 on the Mac (5 pairs, range 0.858 to 2.043) and 1.07 to 1.17 across the Thunder ladder. Workers expose no setting for the tier and the arm was added after the default result, so it is exploratory and gives no pass.

### Static Check Elision

Of the checked accesses on the stock front (732,848,870, 38.4% of all), sound grouping can reach at most 32.4%, which leaves 67.6% of the checked accesses in place. The built arm `g-bcd` removes 10.6% and reads 1.569 on the front against 1.524 for `bcd` in the same run, where the cost model predicted 1.39 to 1.41, for a cause that is not diagnosed. It lowers the other routes: login 1.142, admin 0.885 and ladder 1.010. With no access checked, tau is 0.039, so the checks are the tax ([translation-check-elision](https://github.com/gmitch215/folio/blob/master/results/execution/translation-check-elision/README.md)).

### Compressed Pages and Narrow Arenas

Pages of the continuation PHP guest (96 and 115 MiB images at boot, at event 3 and at the end) compress to a median of 3.9, 3.9 and 7.8 times at 64 KiB per non-zero chunk with zstd. The first two images are 93 to 94% zero chunks. A fault that decodes a compressed page pays only if the decoder runs faster than about 520 to 850 MiB/s, depending on the store it replaces. Inside one deployed Paid object the synchronous decoders in `node:zlib` read 257 MiB/s for inflate (range 180 to 283) and for zstd (193 to 462), on 192 chunks, seven interleaved rounds timed from the client. At 257 MiB/s a compressed fault costs 2.3 to 3.1 times the CPU of an uncompressed read from the object's own storage.

A prediction fitted on the 8 MiB and 32 MiB heap-prefix arms put tau for 4 and 8 arenas on Thunder admin at 0.59 to 0.64. The rig read 1.75 to 2.80 for 4 arenas and 2.84 to 4.30 for 8. The translator emits one range test per arena, and the modules grew from 53 MB to 74 and 102 MB. The rows of both of these are not exported to `results/`.

### The Dynamic Guard Count

An instrumented build counted the guards a design with one residency check per base local, cleared when the base is set again, one check per other pointer expression and one epoch compare after each call would pay per memory access.

| Route and render          |      Accesses | Checks per access | Calls per access | Guards per access |
| ------------------------- | ------------: | ----------------: | ---------------: | ----------------: |
| Thunder admin after login | 4,404,477,769 |            0.2890 |           0.0192 |            0.3083 |
| Stock front, cold         | 1,907,973,973 |            0.3081 |           0.0187 |            0.3268 |
| Stock front, second warm  |   117,009,980 |            0.2640 |           0.0199 |            0.2840 |
| Stock front, third warm   |   110,657,199 |            0.2668 |           0.0202 |            0.2870 |

The static count over the module is 0.3280. Every counted render matched the plain render's normalized hash, and two repeats agree on the ratio to four decimals. The flush route was not counted. A linear projection from an unchecked-access floor of 0.039 and the full range cover's 0.542 on admin gives a tau of about 0.18 to 0.19. That figure is a prediction: no translator emits this design, it assumes a span check costs one compare and that module growth adds nothing, and the narrow-arena arms showed that module growth raises tau ([guard-count](https://github.com/gmitch215/folio/blob/master/results/execution/guard-count/README.md)). The drop criteria were set before the count: a guard rate of 0.7 or more, module growth over 30%, a re-check loop that does not settle, and an epoch arm above 0.40 on admin.

## Reading

Translating each access costs more than the render can absorb at default tiering, and removing provably redundant checks closes little of the gap on this module. The checks are the tax: with none, tau is 0.039. Paging itself works. The local runs are exact down to 327,680 Wasm bytes, the managed run completes, and the one-object ladder is exact on every completed run. The open question is the price of the test per access, and the guard count shows how many tests an epoch design would run.

## Closed and Open

Closed mechanisms: software per-access translation as the PHP paging mechanism at default tiering, static check elision on this module, compressed pages on the fault path, and narrow arenas. The managed page plane misses G-E2 on days 1 and 2.

The objective stays open. Designs that remove the test remain untried: resident pages made free by faulting, hot data pinned by construction, and late switching with retry on kill. The epoch design has a count and a prediction and no build. The growth governor is built and unit tested as the guard for that branch ([Memory Accounting](memory-accounting.md)).

## See Also

- Report: [Elastic Memory Study](../../TECHNICAL_REPORT.md#elastic-memory-study)
- Module: [Memory](../modules/memory.md)
- Related studies: [Memory Accounting](memory-accounting.md), [Parallel Execution](parallel-execution.md)
