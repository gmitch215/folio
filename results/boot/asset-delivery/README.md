# Asset Delivery

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [sequential.json](sequential.json) | 4570 | experiments/bootimage/results-hostboot-assets-20261022-a.json |
| [config-key.json](config-key.json) | 7402 | experiments/bootimage/results-hostboot-assets-20261022-b.json |
| [php-8512.json](php-8512.json) | 9765 | experiments/bootimage/results-hostboot-assets-php8512-20261022-a.json |
| [parallel.json](parallel.json) | 13317 | experiments/bootimage/results-hostboot-parallel-20261022.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
