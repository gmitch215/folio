# Method

## Question

The parent study measured tau, the translation cost, on a 0.85 s PHP front-page render, which spends most of its life in V8's baseline tier. A request that runs 9 s may spend most of its time after V8 has tiered the hot functions up. This study asks whether tau falls as the request gets longer under default tiering.

## Workloads

Each sample is one fresh Node 26 process. The harness is the parent study's census harness with a site switch.

| Key | What runs | Native median, ms |
| --- | --- | --- |
| `stock front` | first uncached front-page render, stock Drupal | 1,686 (10 pairs) |
| `stock flush` | `drupal_flush_all_caches()`, the longest stock census workload, not an HTTP request | 2,717 (10 pairs) |
| `thunder login` | anonymous `/user/login` on Thunder, primed database copy | 1,149 (10 pairs) |
| `thunder admin` | authenticated cold `/admin/content` on Thunder | 2,758 (5 pairs) |
| `thunder ladder` | authenticated `/admin/modules` on Thunder, rendered 7 times in one process with the page, dynamic page cache and render bins emptied each time | 2,432 after render 1, 11,049 after render 7 |

The ladder is a different workload from a single request. Render 1 runs 851 queries. Renders 2 to 7 run 164 or 196 queries because Drupal's database-backed caches and PHP static state are warm. Cumulative time after render k is the rung. The rungs reach 9,589 ms native at render 6 and 11,049 ms at render 7. Nothing was extrapolated beyond render 7.

Thunder census workloads `modules`, `flush` and `cim` and the stock `modules` and `content` routes were not sampled for this study. Thunder's `/admin/modules` first render is ladder render 1. The sweep over the others was cut after the ladder took about 50 minutes for 12 samples under machine stalls.

## Arms

`native` is the shipping interpreter module. `emit` is the control: Binaryen read and write with no pass. `b` is the shared-helper form with stack and constant-address exemption. `bcd` is the full inline path (exempt, hoist, inline lookup). The modules are the ones built by the parent study. Tau is the median over pairs of arm time over native time from the same repeat, minus one.

## Procedure

Default tiering is the main table: no V8 flags, Node v26.8.2, V8 14.6.202.34-node.28, `execArgv` empty in every sample. Optimized tier (`--no-liftoff --no-wasm-lazy-compilation`) is a second table labelled exploratory, run for `native`, `b` and `bcd` on the Thunder ladder and the stock front render only.

Arms are interleaved within a repeat and the order rotates. Before each batch the runner waits for a one-minute load average below 4, for at most 120 s (first sweep) or 30 s to 60 s (later sweeps). The load never fell below 4 for long: 156 of 160 default rows record a wait, and the load average ranged from 3.6 to 58.9 across all samples. Each sample records the load average at start and end. Another lane's test runs shared the machine, and swap use was near its total during the early samples.

Pairs where either sample exceeds 50 times the median native time are dropped (the parent study's rule, `STALL`). That rule caught one pair on the ladder at four rungs and one on stock front. It did not catch the smaller stalls, such as a single ladder render of 118 s against a 1.3 s native render, which is 13 times the rung median. Those stay in the median. The unfiltered ratio is in `summary.json` beside the filtered one. The raw files keep every sample.

The stock front and flush and Thunder login workloads have two batches: repeats 1 to 5 and repeats 6 to 10, because the first five were too noisy to read. Both batches are in the table.

One observation run, separate from the timed samples, ran the `bcd` ladder with `--trace-wasm-compilation-times`. It was not promoted because its log carries local paths. Counts only are quoted in the README.

## Reproduction

`translation-duration-summary.ts` turns `raw-default.jsonl` and `raw-optimized.jsonl` into `summary.json`. `source/run-bench.ts` is the runner with local paths replaced by `BENCH_DIR`. The harness is the parent study's with a `--site=stock|thunder` switch (Thunder from a primed copy of its database and 8,310 delivered files) and a `ladder` workload; it is not tracked.

```sh
node scripts/research/translation-duration-summary.ts results/execution/translation-tax/duration
```
