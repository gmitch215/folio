# Placement Pilot

Instrument: [control-affinity.mjs](../../../scripts/probe/control-affinity.mjs).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [affinity.jsonl](affinity.jsonl) | 210066 | results/20261020-affinity/affinity.jsonl |
| [exit-code](exit-code) | 2 | results/20261020-affinity/exit-code |
| [runner.log](runner.log) | 72 | results/20261020-affinity/runner.log |
| [source.tar.gz](source.tar.gz) | 197798 | results/20261020-affinity/source.tar.gz |
| [summary.json](summary.json) | 46721 | results/20261020-affinity/summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
