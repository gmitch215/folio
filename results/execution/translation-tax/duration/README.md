# Translation Tax Against Request Duration

Question: does tau, the cost of routing every load and store through a software page table, fall as a request runs longer, once V8 has tiered the hot functions up?

Result: no. Under default tiering the full inline path (`bcd`) has a cumulative tau of 1.19 after 2.4 s of native work and 1.18 after 11.0 s, and per-render steady-state tau near 1.1. The optimized tier gives 1.08 to 1.17 on the same ladder with a tight range. G-tau (tau at most 1) is not met on the Thunder routes in either tier. On the short stock renders it sits at the threshold, 0.89 to 1.02, with ranges too wide to call.

## Inputs

| File | Contents |
| --- | --- |
| `raw-default.jsonl` | 160 fresh-process samples under default V8 flags |
| `raw-optimized.jsonl` | 30 samples under `--no-liftoff --no-wasm-lazy-compilation` |
| `summary.json` | tau, range, native median and stalled pairs per workload and rung |
| `source/` | the runner, local paths replaced by `BENCH_DIR` |

[METHOD.md](METHOD.md) has the workloads, the load handling and the stall rule.

## Results, default tiering

Node v26.8.2, V8 14.6.202.34-node.28. Tau is the median of per-pair ratios minus one; the range is over pairs. Machine load average ran from 3.6 to 58.9 and the stall rule is the parent study's.

| Workload | Native median, ms | Pairs | `emit` tau | `b` tau | `bcd` tau | `bcd` range |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| thunder login | 1,149 | 10 | -0.01 | 0.83 | 1.36 | 0.49 to 3.72 |
| stock front | 1,686 | 10 (9 for `bcd`) | 0.06 | 1.11 | 1.02 | -0.93 to 5.10 |
| thunder ladder, render 1 | 2,432 | 5 | 0.02 | 1.60 | 1.19 | 0.89 to 3.13 |
| thunder admin | 2,758 | 5 | 0.04 | 1.21 | 1.28 | 0.35 to 1.55 |
| stock flush | 2,717 | 10 | -0.02 | 1.06 | 0.89 | -0.65 to 5.10 |
| thunder ladder, render 2 | 3,764 | 5 (4) | 0.03 | 1.78 | 2.33 | 0.85 to 38.3 |
| thunder ladder, render 4 | 6,458 | 5 (4) | 0.03 | 1.96 | 1.73 | 0.99 to 23.1 |
| thunder ladder, render 6 | 9,589 | 5 | 0.02 | 1.97 | 1.20 | 1.01 to 16.7 |
| thunder ladder, render 7 | 11,049 | 5 | -0.05 | 1.96 | 1.18 | 0.59 to 14.7 |

Ranges above 3 come from single-sample machine stalls, not from the arms: one `bcd` ladder sample spent 401 s in render 2, another 143 s. Renders 3 to 7 of the ladder are in `summary.json`.

Median time of one ladder render, ms, from `summary.json` (`ladderRenderMedianMs`):

| Render | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| native | 2,432 | 1,360 | 1,276 | 1,350 | 1,288 | 1,429 | 1,421 |
| `b` | 6,329 | 3,907 | 3,701 | 4,111 | 3,780 | 3,957 | 3,639 |
| `bcd` | 5,191 | 9,198 | 2,836 | 2,950 | 2,748 | 2,835 | 2,737 |

From render 3 on, `bcd` is 1.9 to 2.2 times native per render and `b` is 2.6 to 3.0 times. The `bcd` render 2 median is inflated by two stalled samples. The first render costs 2.1 times native for `bcd`, so tau does not fall from the cold render to the warm ones.

## Results, optimized tier (exploratory)

| Workload | Native median, ms | `b` tau | `bcd` tau | `bcd` range |
| --- | ---: | ---: | ---: | --- |
| stock front | 1,165 | 1.30 | 0.76 | -0.25 to 1.61 |
| thunder ladder, render 1 | 3,495 | 1.65 | 1.08 | 0.92 to 1.22 |
| thunder ladder, render 4 | 9,619 | 1.92 | 1.10 | 1.06 to 1.22 |
| thunder ladder, render 6 | 13,708 | 1.89 | 1.17 | 1.06 to 1.27 |
| thunder ladder, render 7 | 15,707 | 1.87 | 1.14 | 1.07 to 1.32 |

Five pairs each. This table has no `emit` arm.

## Tier observation

One separate run of the `bcd` ladder with `--trace-wasm-compilation-times`: 3,137 Liftoff compilations in the process, 550 TurboFan compilations before the ladder starts and 586 during it. The TurboFan compilations during the ladder kept arriving through the last renders; they were not mapped to render numbers. Only the `bcd` arm was observed. The tier of the `native` module during the samples was not observed.

## Limits

The ladder repeats one route. It does not match a single 9 s request, whose later phases run different PHP code. The machine was shared and under memory pressure, and the load never settled. The stall rule removed two pairs and leaves stalls of 10 to 50 times the median in the medians. Native times on this machine are not platform times. Thunder `modules`, `flush` and `cim` and the stock `modules` and `content` routes were not run in this study.
