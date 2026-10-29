# Deployment

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [original.json](original.json) | 1857 | experiments/consumer/results-free-php-20261020.json |
| [combined.json](combined.json) | 2318 | experiments/consumer/results-free-prepared-combined-20261020.json |
| [parts.json](parts.json) | 2272 | experiments/consumer/results-free-prepared-parts-20261020.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
