# Host

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [repeated.json](repeated.json) | 1148 | experiments/cloud/results-host-20261020.json |
| [current-runtime.json](current-runtime.json) | 1146 | experiments/cloud/results-host-consolidated.json |
| [checked.json](checked.json) | 1147 | experiments/cloud/results-host-final.json |
| [second.json](second.json) | 1148 | experiments/cloud/results-host-local-v2.json |
| [first.json](first.json) | 1070 | experiments/cloud/results-host-local.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
