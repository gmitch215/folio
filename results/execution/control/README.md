# Control Flow

Instrument: [control-probe.mjs](../../../scripts/probe/control-probe.mjs).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [control.jsonl](control.jsonl) | 57567 | results/20261020-control-b/control.jsonl |
| [exit-code](exit-code) | 2 | results/20261020-control-b/exit-code |
| [runner.log](runner.log) | 74 | results/20261020-control-b/runner.log |
| [source.tar.gz](source.tar.gz) | 175414 | results/20261020-control-b/source.tar.gz |
| [summary.json](summary.json) | 6578 | results/20261020-control-b/summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
