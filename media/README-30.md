# Translation Tau Rig

Question: on a quiet machine, how much does each translation arm cost on the five PHP render routes, and could a cheaper test per access reach tau 1?

Tau is the translated render over the native render minus one. The gate was a median tau of at most 1 on each PHP render route at default V8 tiering.

Result: G-tau is NOT MET. The full path (`bcd`: stack and static accesses exempt, invariant lookups hoisted, one inlined lookup per remaining access) reads 1.581 (interval 1.537 to 1.617) on the stock front page, 1.287 on Thunder login, 1.088 on Thunder admin, 1.184 on the repeated-render ladder and 1.155 on the flush route, which returns no HTML and is not gated. The idealized arm `r-all`, in which every access is in range and costs one range test, reads 1.111 (1.036 to 1.182) on the front and 1.023 on login, so a perfect hit rate that keeps a per-access range test cannot reach 1 on the stock front.

| Route | `bcd` | per-site cache `csite` | per-function cache `cfn` | stack-only range `r-stack` | heap prefix 8 MiB `r-heap8` | heap prefix 32 MiB `r-heap32` | `r-all` |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| stock front | 1.581 | 1.817 | 1.709 | 1.674 | 1.516 | 1.396 | 1.111 |
| Thunder login | 1.287 | 1.601 | 1.481 | 1.361 | 1.286 | 1.091 | 1.023 |
| Thunder admin | 1.088 | 1.183 | 1.074 | 1.054 | 0.883 | 0.844 | 0.542 |
| Thunder ladder | 1.184 | 1.294 | 1.188 | 1.172 | 0.910 | 0.806 | 0.526 |
| stock flush | 1.155 | 1.090 | 1.061 | 1.125 | 0.855 | 0.831 | 0.479 |

Ten pairs per cell. Every arm's normalized HTML equals native.

## Inputs

| File | Contents |
| --- | --- |
| `raw/all.jsonl` | 400 rows, one per fresh-process sample: route, arm, repeat, wall time, host load, cgroup CPU, module digest |
| `raw/clean.jsonl`, `raw/raw-claim.jsonl` | the subset that meets the claim-grade rule and the claim rows |
| `summary-all.json`, `summary-clean.json` | per route and arm: tau, interval, n, native median |
| `raw/sweep2.log`, `raw/sweep2.sampler.tsv`, `raw/sweep2.df` | the run log, host load samples and disk record |

## Instrument

`node scripts/research/translation-tau2-summary.ts OUT RAW...` writes the summaries from the raw rows. The arms are built by `scripts/research/elastic-translate.ts`. The rig is an x86_64 Ryzen 9 9900X container with the native render timed in the same process family.

## Limits

305 of 400 rows started at a one-minute load of 1.0 or over, the tau container's own earlier arms. Every row meets the summary's claim-grade rule (no sample at load 4 or over), and 0 of 400 overlap a busy non-tau container. A stricter per-sample rerun cannot change the verdict, because the closest arm fails by 11% with an interval that excludes 1. One admin `r-all` repeat reads 8.56x native and is unexplained. `r-all` is not an implementable pager. Native times are the rig's, not the platform's.
