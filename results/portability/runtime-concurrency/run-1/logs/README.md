# Logs

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [a.log](a.log) | 0 | results/20261022-workerd-concurrency/run-1/logs/a.log |
| [b.log](b.log) | 0 | results/20261022-workerd-concurrency/run-1/logs/b.log |
| [c.log](c.log) | 0 | results/20261022-workerd-concurrency/run-1/logs/c.log |
| [d0.log](d0.log) | 0 | results/20261022-workerd-concurrency/run-1/logs/d0.log |
| [d1.log](d1.log) | 0 | results/20261022-workerd-concurrency/run-1/logs/d1.log |
| [d2.log](d2.log) | 0 | results/20261022-workerd-concurrency/run-1/logs/d2.log |
| [d3.log](d3.log) | 0 | results/20261022-workerd-concurrency/run-1/logs/d3.log |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../../../scripts/README.md).
