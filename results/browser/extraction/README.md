# Extraction

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [deployed.json](deployed.json) | 8996 | experiments/browser/results-free-extraction-20261020.json |
| [without-jspi.json](without-jspi.json) | 7690 | results/browser-extraction-local-no-jspi.json |
| [local.json](local.json) | 7636 | results/browser-extraction-local.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
