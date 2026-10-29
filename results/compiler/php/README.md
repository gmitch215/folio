# Php

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [prepared.json](prepared.json) | 1057 | results/php-preparation-20261020.json |
| [before.json](before.json) | 907 | results/php-preparation-before-20261020.json |
| [cached.json](cached.json) | 1057 | results/php-preparation-cached-20261020.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
