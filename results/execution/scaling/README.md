# CPU Scaling

Instrument: [scaling-probe.ts](../../../scripts/probe/scaling-probe.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [exit-code](exit-code) | 2 | results/20261019-d/exit-code |
| [runner.log](runner.log) | 415 | results/20261019-d/runner.log |
| [scaling.jsonl](scaling.jsonl) | 96961 | results/20261019-d/scaling.jsonl |
| [source.tar.gz](source.tar.gz) | 29970 | results/20261019-d/source.tar.gz |
| [summary.json](summary.json) | 25708 | results/20261019-d/summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
