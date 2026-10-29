# Boot Images PHP 8.5.2

Instrument: [boot-image.ts](../../../scripts/probe/boot-image.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [mac-anatomy.jsonl](mac-anatomy.jsonl) | 11321 | results/20261022-bootimage/mac-anatomy.jsonl |
| [mac-bake.jsonl](mac-bake.jsonl) | 1391 | results/20261022-bootimage/mac-bake.jsonl |
| [mac-baked-anatomy.jsonl](mac-baked-anatomy.jsonl) | 36114 | results/20261022-bootimage/mac-baked-anatomy.jsonl |
| [mac-baked-arms.jsonl](mac-baked-arms.jsonl) | 66860 | results/20261022-bootimage/mac-baked-arms.jsonl |
| [mac-baked-bake.jsonl](mac-baked-bake.jsonl) | 4769 | results/20261022-bootimage/mac-baked-bake.jsonl |
| [mac-baked-pin.jsonl](mac-baked-pin.jsonl) | 993 | results/20261022-bootimage/mac-baked-pin.jsonl |
| [mac-baked-reference.jsonl](mac-baked-reference.jsonl) | 9769 | results/20261022-bootimage/mac-baked-reference.jsonl |
| [mac-baked-render.jsonl](mac-baked-render.jsonl) | 4679 | results/20261022-bootimage/mac-baked-render.jsonl |
| [mac-baked-replay.jsonl](mac-baked-replay.jsonl) | 167423 | results/20261022-bootimage/mac-baked-replay.jsonl |
| [mac-baked-seed.jsonl](mac-baked-seed.jsonl) | 2132 | results/20261022-bootimage/mac-baked-seed.jsonl |
| [mac-baked-seedtest.jsonl](mac-baked-seedtest.jsonl) | 18616 | results/20261022-bootimage/mac-baked-seedtest.jsonl |
| [mac-baked-workerd.jsonl](mac-baked-workerd.jsonl) | 150953 | results/20261022-bootimage/mac-baked-workerd.jsonl |
| [mac-deliver.jsonl](mac-deliver.jsonl) | 93534 | results/20261022-bootimage/mac-deliver.jsonl |
| [mac-phases.jsonl](mac-phases.jsonl) | 17895 | results/20261022-bootimage/mac-phases.jsonl |
| [mac-render.jsonl](mac-render.jsonl) | 3289 | results/20261022-bootimage/mac-render.jsonl |
| [mac-retain.jsonl](mac-retain.jsonl) | 6049 | results/20261022-bootimage/mac-retain.jsonl |
| [summary.json](summary.json) | 121734 | results/20261022-bootimage/summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
