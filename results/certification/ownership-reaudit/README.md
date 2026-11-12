# Ownership Re-audit

Question: does the frozen ownership checker still certify the six drivers, pass the twelve gates, and accept no wrong module in the adversary families?

Result: yes, with no accepted-and-wrong row. The census certifies 6 of 6 drivers. All twelve gate steps have zero differences and their negative controls differ. No family reports a wrong or `false` row. The accepted counts equal the counts on the tree before the fixes in every family, so these families do not exercise the new refusals; the new refusals are covered by the red team generators and the unit tests. Seven base split jobs timed out at 60 s on a loaded Mac and the accepted count stayed 268.

| Family | Rows | Accepted | Wrong | Premise | Timeouts |
| --- | ---: | ---: | ---: | ---: | ---: |
| prefix | 418 | 178 | 0 | 2 | 0 |
| relational | 366 | 187 | 0 | 0 | 0 |
| kissfft | 391 | 233 | 0 | 2 | 0 |
| kissfft driver | 81 | 50 | 0 | 2 | 0 |
| cursor | 1,324 | 549 | 0 | 30 | 0 |
| bytes | 1,364 | 790 | 0 | 0 | 0 |
| cap | 2,357 | 1,393 | 0 | 0 | 14 |
| extent | 114 | 71 | 0 | 0 | 0 |
| stackidx | 2,863 | 813 | 0 | 0 | 61 |
| alloc-yyjson | 5,187 | 1,162 | 0 | 0 | 4 |
| base split | 990 | 268 | 0 | 0 | 7 |

## Inputs

| Directory | Contents |
| --- | --- |
| `mac/` | the census logs, twelve gate runs with controls, the base split family, `FREEZE.txt` and `RUN-LOG.txt`, run on the arm64 Mac |
| `rig/` | the ten other families with summaries, the counter family, `FREEZE.txt` and `RUN-LOG.txt`, run in one container on the x86_64 rig |

## Instrument

The adversary scripts and gates named in `scripts/README.md`, run on the frozen checker. Both halves recorded the freeze hash `cc8544d0c61c40e2b5d0fa3cb918611bbc32b16ee9c36af2085f5f3ea66b9d60` at the start, and it was equal at the end. `OWNERSHIP_CHECKER` is `folio-ownership-2`.

## Limits

The premise rows of the cursor family change their `route` field between runs, so the comparison reads `outcome` and `regions`, not `route`. The kissfft census log prints only `certificate`, with no window. The rig load maximum was recorded in a sampler file that is not exported. The cause of the seven base split timeouts was not measured; the Mac load was about 10 during that step.
