# Serial PHP

Instrument: [php-workloads.ts](../../../scripts/probe/php-workloads.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [census-php.json](census-php.json) | 193794 | results/20261020-php/census-php.json |
| [native-render.cpuprofile.gz](native-render.cpuprofile.gz) | 190654 | results/20261020-php/native-render.cpuprofile.gz |
| [profile-summary.json](profile-summary.json) | 2389 | results/20261020-php/profile-summary.json |
| [render.jsonl](render.jsonl) | 11326 | results/20261020-php/render.jsonl |
| [render.summary.json](render.summary.json) | 3198 | results/20261020-php/render.summary.json |
| [workloads.jsonl](workloads.jsonl) | 327648 | results/20261020-php/workloads.jsonl |
| [workloads.summary.json](workloads.summary.json) | 45609 | results/20261020-php/workloads.summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
