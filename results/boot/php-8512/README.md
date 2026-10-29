# Boot Images PHP 8.5.12

Instrument: [boot-image.ts](../../../scripts/probe/boot-image.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [mac-baked-anatomy.jsonl](mac-baked-anatomy.jsonl) | 41274 | results/20261022-bootimage-php8512/mac-baked-anatomy.jsonl |
| [mac-baked-arms.jsonl](mac-baked-arms.jsonl) | 66796 | results/20261022-bootimage-php8512/mac-baked-arms.jsonl |
| [mac-baked-bake.jsonl](mac-baked-bake.jsonl) | 6638 | results/20261022-bootimage-php8512/mac-baked-bake.jsonl |
| [mac-baked-pin.jsonl](mac-baked-pin.jsonl) | 649 | results/20261022-bootimage-php8512/mac-baked-pin.jsonl |
| [mac-baked-reference.jsonl](mac-baked-reference.jsonl) | 9715 | results/20261022-bootimage-php8512/mac-baked-reference.jsonl |
| [mac-baked-render.jsonl](mac-baked-render.jsonl) | 3948 | results/20261022-bootimage-php8512/mac-baked-render.jsonl |
| [mac-baked-replay.jsonl](mac-baked-replay.jsonl) | 167849 | results/20261022-bootimage-php8512/mac-baked-replay.jsonl |
| [mac-baked-seed.jsonl](mac-baked-seed.jsonl) | 2120 | results/20261022-bootimage-php8512/mac-baked-seed.jsonl |
| [mac-baked-seedtest.jsonl](mac-baked-seedtest.jsonl) | 18630 | results/20261022-bootimage-php8512/mac-baked-seedtest.jsonl |
| [mac-baked-workerd.jsonl](mac-baked-workerd.jsonl) | 151052 | results/20261022-bootimage-php8512/mac-baked-workerd.jsonl |
| [summary.json](summary.json) | 67408 | results/20261022-bootimage-php8512/summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
