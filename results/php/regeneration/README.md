# Page Regeneration

Instrument: [php-regen.ts](../../../scripts/probe/php-regen.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [mac-smoke.jsonl](mac-smoke.jsonl) | 3285 | results/20261022-phpregen/mac-smoke.jsonl |
| [nosmt-regen-machine.txt](nosmt-regen-machine.txt) | 757 | results/20261022-phpregen/nosmt-regen-machine.txt |
| [nosmt-regen.jsonl](nosmt-regen.jsonl) | 29655 | results/20261022-phpregen/nosmt-regen.jsonl |
| [nosmt-regen.summary.json](nosmt-regen.summary.json) | 11762 | results/20261022-phpregen/nosmt-regen.summary.json |
| [smt-regen-machine.txt](smt-regen-machine.txt) | 766 | results/20261022-phpregen/smt-regen-machine.txt |
| [smt-regen.jsonl](smt-regen.jsonl) | 40172 | results/20261022-phpregen/smt-regen.jsonl |
| [smt-regen.summary.json](smt-regen.summary.json) | 14087 | results/20261022-phpregen/smt-regen.summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
