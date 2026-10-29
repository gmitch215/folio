# Control Flow Pilot

Instrument: [control-probe.mjs](../../../scripts/probe/control-probe.mjs).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [control.jsonl](control.jsonl) | 57581 | results/20261020-control/control.jsonl |
| [exit-code](exit-code) | 2 | results/20261020-control/exit-code |
| [runner.log](runner.log) | 70 | results/20261020-control/runner.log |
| [source.tar.gz](source.tar.gz) | 171707 | results/20261020-control/source.tar.gz |
| [summary.json](summary.json) | 6567 | results/20261020-control/summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
