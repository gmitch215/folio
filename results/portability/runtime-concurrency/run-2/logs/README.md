# Logs

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [single.log](single.log) | 0 | results/20261022-workerd-concurrency/run-2/logs/a.log |
| [front.log](front.log) | 0 | results/20261022-workerd-concurrency/run-2/logs/b.log |
| [sockets.log](sockets.log) | 0 | results/20261022-workerd-concurrency/run-2/logs/c.log |
| [processes-0.log](processes-0.log) | 0 | results/20261022-workerd-concurrency/run-2/logs/d0.log |
| [processes-1.log](processes-1.log) | 0 | results/20261022-workerd-concurrency/run-2/logs/d1.log |
| [processes-2.log](processes-2.log) | 0 | results/20261022-workerd-concurrency/run-2/logs/d2.log |
| [processes-3.log](processes-3.log) | 0 | results/20261022-workerd-concurrency/run-2/logs/d3.log |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../../../scripts/README.md).
