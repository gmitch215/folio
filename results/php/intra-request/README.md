# Explicit Request Tasks

Instrument: [php-intra.ts](../../../scripts/probe/php-intra.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [indirect-mac.jsonl](indirect-mac.jsonl) | 100677 | results/20261020-phpintra/indirect-mac.jsonl |
| [indirect-mac.summary.json](indirect-mac.summary.json) | 7485 | results/20261020-phpintra/indirect-mac.summary.json |
| [intra-drupal-rig.jsonl](intra-drupal-rig.jsonl) | 109409 | results/20261020-phpintra/intra-drupal-rig.jsonl |
| [intra-drupal-rig.summary.json](intra-drupal-rig.summary.json) | 15031 | results/20261020-phpintra/intra-drupal-rig.summary.json |
| [intra-rig.jsonl](intra-rig.jsonl) | 634839 | results/20261020-phpintra/intra-rig.jsonl |
| [intra-rig.summary.json](intra-rig.summary.json) | 75516 | results/20261020-phpintra/intra-rig.summary.json |
| [rig-load-before-intra-drupal.txt](rig-load-before-intra-drupal.txt) | 71 | results/20261020-phpintra/rig-load-before-intra-drupal.txt |
| [rig-load-before-intra.txt](rig-load-before-intra.txt) | 71 | results/20261020-phpintra/rig-load-before-intra.txt |
| [rig-load-before-snapshot.txt](rig-load-before-snapshot.txt) | 71 | results/20261020-phpintra/rig-load-before-snapshot.txt |
| [rig-machine-2.txt](rig-machine-2.txt) | 667 | results/20261020-phpintra/rig-machine-2.txt |
| [rig-machine.txt](rig-machine.txt) | 638 | results/20261020-phpintra/rig-machine.txt |
| [snapshot-rig.jsonl](snapshot-rig.jsonl) | 8550 | results/20261020-phpintra/snapshot-rig.jsonl |
| [snapshot-rig.summary.json](snapshot-rig.summary.json) | 1288 | results/20261020-phpintra/snapshot-rig.summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
