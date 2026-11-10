# Method

## Question

What does it cost every load and store to go through a software page table with every page resident, on the PHP render that motivated the elastic memory work, and how much of that cost can static analysis remove? Tau is `T_translated / T_native - 1`. Gate G-tau: tau at most 1 on the PHP render after exempting provably pinned accesses, hoisting invariant lookups and using the one-compare lookup. The threshold was fixed before any run and is not retuned.

## Instruments

| Number | Instrument |
| --- | --- |
| Render time | `wallMs` of the first uncached front-page render, `performance.now()` around `renderPage()` in a Node 26 process, one fresh process per sample |
| Access counts per page and per region | counters added by an import on every load and store of `wasm-opt --instrument-memory` output (`source/counter.ts`), request phase only |
| Dynamic share per access class | exported i32 counters written by the translating pass itself (`count` arm), read before and after the first render |
| Static site counts, build time, module bytes | `translate()` statistics in `arms/*.json` |
| Straddles and slow-path calls | counters in the host import (`translationHost`) |
| Machine load | `os.loadavg()` at the start and end of each sample |

## Module and workload

The shipping interpreter `.interp/php8.5.tuned.wasm`, 14,011,467 bytes, sha256 `3fb160241bdc702ab6b9d1b8a1a9e0acceae30e0e0ce5f4456f90214192b80ce`, PHP 8.5.12 with `USE_ZEND_ALLOC=0`, stock Drupal over in-memory SQLite through the production driver, the same harness as the page-touch census with the recorder replaced by the translation host. The workload is the anonymous front page with the page, dynamic page cache and render bins emptied first (267 queries). Renders 2 and 3 in the same process run 43 and 40 queries because Drupal and PHP warm caches, so they are a different workload and are recorded but not used for tau.

## The translating pass

`scripts/research/elastic-translate.ts` reads a module with an imported memory and rewrites every load and store. A table of 65,536 i32 entries lives in that memory at a fixed address (the first page past the stack reservation floor in this study). Entry k holds the delta between the frame base and page k's base, or -1 when the page is not resident. An access at `ptr + offset` becomes the same access, with its own align and offset immediates, on `ptr + delta`. The lookup is one shift and mask, one table load, one test and one add. The test is one branch for a missing page, an address that wrapped past 4 GiB (only when the offset is not zero) and an access that crosses into the next page (only for widths above one byte). Any of them calls the `folio.slow` import, which here traps with a typed message.

The module is refused, with the reasons listed, when it contains atomics, memory.copy, memory.fill, memory.init, SIMD memory accesses or exception handling. memory.size and memory.grow pass through unchanged, which is correct only while the table is the identity map; a virtualizing host has to update the table on grow.

A store whose value is not a constant or a local is rewritten to evaluate the pointer, then the value, then translate, so a miss handler that runs inside the value cannot invalidate a frame computed earlier.

## Arms

| Arm | Lookup | Exempt | Hoist |
| --- | --- | --- | --- |
| `native` | none | | |
| `emit` | none, module read and written back by Binaryen | | |
| `a` | shared helper called per access | no | no |
| `b` | helper | yes | no |
| `c` | helper | yes | yes |
| `bd` | inlined | yes | no |
| `bcd` | inlined | yes | yes |
| `trust` | inlined | yes | yes, and no crossing check where align is at least the width |
| `count` | inlined, with class counters | yes | yes |

`bcd` is the G-tau arm. Exempt accesses are loads and stores whose pointer is provably the stack pointer plus a constant (a local whose every assignment is that, or the global itself, offset under 64 KiB) or a constant address below the end of the stack reservation. Each write to the stack pointer that is not an increase gets a bound check against a pinned window of 1 MiB below the stack base. Hoisting applies to innermost loops with no calls, nested loops or memory.grow, where every access that is not exempt has a pointer that is a local the loop never assigns, or such a local plus a constant. Those lookups run once before the loop. A hoisted lookup can raise a miss for an access the loop does not execute.

Folio's `src/ranges.ts` and `src/read-scan.ts` hold dynamic footprints, not static address ranges, so the pass reuses neither. Stride and induction-range hoisting, which would need the analysis in `src/extract.ts`, is not implemented.

## Procedure

Per repeat, every arm runs once in a fresh process, in an order rotated each repeat. Five repeats under default V8 flags (`default`). Six repeats under `--no-liftoff --no-wasm-lazy-compilation` for `native`, `b` and `bcd` (`optimized`), which compiles everything with the optimizing tier before the request. Pairs where either sample exceeds 50 times the median native time are dropped as stalls (`STALL` in `translation-tax-summary.ts`, applied to every arm, counted as `stalledPairs`); the unfiltered median ratio is kept beside it. Pairs are the arm and native from the same repeat; the summary takes the median and the range of per-pair ratios. A first attempt at `optimized` exited immediately because Binaryen's own module would not compile under those flags; its nine records are not promoted because their stderr carries local paths, and the host half of the pass moved into a module that does not load Binaryen.

The table is filled for all 65,536 pages with delta 0 before instantiation, so growth needs no update and every page is resident and identity-mapped. Frames cannot differ from pages in this study because the host glue (file reads into the heap, string marshalling) addresses linear memory directly.

## Reproduction

`translation-tax-summary.ts` turns `span/`, `arms/` and `bench/` into `summary.json`. `source/` holds the scripts with local paths replaced by environment variables; the harness is the page-touch census harness (not tracked) with the recorder swapped for `translationHost`.
