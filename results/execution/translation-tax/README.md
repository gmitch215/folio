# Translation Tax

Question: how much does it cost every load and store to go through a software page table with every page resident, on the PHP render that motivated elastic memory, and how much of that cost can static analysis remove?

Result: the full path (shadow-stack and constant-address accesses left untranslated, invariant lookups hoisted, one inlined lookup per remaining access) costs a tau of 1.58 on the first uncached front-page render under default V8 tiering and 0.87 once the module is compiled by the optimizing tier before the request. The gate of tau at most 1 fails in the first case and passes in the second. Hoisting contributed nothing measurable: 16 of 1.9 billion accesses qualified. The window idea fails on address span: the 90% hot set is 23 to 53 pages but spans 86.5% to 98.7% of linear memory.

## Inputs

| Directory | Contents |
| --- | --- |
| `span/` | per-page read and write counts for four Drupal workloads on the shipping interpreter, and the region boundaries |
| `arms/` | build record of every translated module: options, build time, bytes, static site counts |
| `bench/` | one JSON line per fresh-process sample, `default` (5 repeats, 8 arms) and `optimized` (6 repeats, 3 arms) |
| `source/` | the scripts that built the arms and ran the samples, local paths replaced by environment variables |
| `duration/` | tau against request duration on Thunder, stock Drupal and a repeated-render ladder; see its own README |

## Instrument

`scripts/research/elastic-translate.ts` is the Binaryen pass; `translation-span.ts` and `translation-tax-summary.ts` compute `summary.json`. Render time is `performance.now()` around the first uncached render in a Node 26 process. Access counts come from an import on every load and store; class shares from counters the pass writes. [METHOD.md](METHOD.md) has the arms, the stall rule and the limits.

## Results

Native median 849 ms (default) and 793 ms (optimized). Tau is the median of per-repeat ratios minus one.

| Arm | Exempt | Hoist | Lookup | Default tau | Optimized tau |
| --- | --- | --- | --- | ---: | ---: |
| a | no | no | helper call | 3.43 | not run |
| b | yes | no | helper call | 1.34 | 1.37 |
| c | yes | yes | helper call | 1.28 | not run |
| bd | yes | no | inline | 1.51 | not run |
| bcd | yes | yes | inline | 1.58 | 0.87 |
| bcd, no crossing check where align is at least the width | yes | yes | inline | 1.42 | not run |
| no pass, module rewritten only | | | | 0.01 | not run |

- Static exempt share: 771,204 of 1,243,219 access sites (62.0%). Dynamic share on the request: stack 56.9%, constant static 4.7%, checked 38.4%, hoisted 0.0%.
- Pairs over 50 times the native median are dropped as machine stalls and listed in `summary.json` as `stalledPairs`. The machine was shared and its load average ran from 3.7 to 18.9.
- Every arm produced the same normalized HTML as native.
- Under default tiering the helper beats the inline form; under the optimizing tier the inline form wins. Which tier a production isolate runs a 9 s request in was not measured.

## Span

The shadow stack takes 68.5% to 75.5% of accesses and a single page holds half. Hot 90% set span is 81.9 to 90.9 MiB against 82.9 to 105.1 MiB of linear memory. See the span section of `summary.json`.

## Limits

One interpreter, one site, one machine under load. The six gmux census programs were not run: they are not built locally. Atomics, memory.copy, memory.fill, memory.init, SIMD memory access and exception handling are refused, not lowered. Frames equal pages in every run, so no fill or eviction cost is measured.
