# Router Ablation Development

Question: do the independent analyses and one shared analysis route the 38 development drivers differently, and what did the five-arm table read on the Mac before the router changed?

Result: the certification decisions are identical on 38 of 38 drivers in both modes. The certification times overlap across three repetitions (independent 10,742, 10,016 and 9,882 ms, shared 10,431, 10,277 and 10,117 ms), so no benefit of one shared analysis is shown. The earlier table, measured on a loaded Mac with load 5 to 19 and the router before two later changes, gave geomeans of 1.127 for the unrouted route, 0.999 for the certified summary alone, 1.037 for the window alone, 1.027 for the two analyses run independently and 1.033 for one shared analysis.

## Inputs

| File | Contents |
| --- | --- |
| `dev-certify.jsonl` | route, reason and certification time per driver and mode |
| `dev-summary.json`, `dev-summary.txt` | the five-arm table and its totals |
| `raw/dev-run.jsonl` | the samples behind the table |

## Instrument

`scripts/research/router-ablation.ts`. The rows were written on 10 November on a Mac under load.

## Limits

The table predates two router changes and a rebuild of the qoi pair. It is indicative only. An earlier summary quoted +1.7% for the shared analysis (10,223 ms against 10,050 ms), and the per-repetition times above overlap, so that figure is dropped.
