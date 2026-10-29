# Library Task Pool

Instrument: [php-intra.ts](../../../scripts/probe/php-intra.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [intra-drupal-rig.jsonl](intra-drupal-rig.jsonl) | 109309 | results/20261020-phptasks-lib/intra-drupal-rig.jsonl |
| [intra-drupal-rig.summary.json](intra-drupal-rig.summary.json) | 15087 | results/20261020-phptasks-lib/intra-drupal-rig.summary.json |
| [intra-machine.txt](intra-machine.txt) | 664 | results/20261020-phptasks-lib/intra-machine.txt |
| [intra-rig.jsonl](intra-rig.jsonl) | 318939 | results/20261020-phptasks-lib/intra-rig.jsonl |
| [intra-rig.summary.json](intra-rig.summary.json) | 38809 | results/20261020-phptasks-lib/intra-rig.summary.json |
| [load-before-intra-drupal.txt](load-before-intra-drupal.txt) | 71 | results/20261020-phptasks-lib/load-before-intra-drupal.txt |
| [load-before-intra.txt](load-before-intra.txt) | 71 | results/20261020-phptasks-lib/load-before-intra.txt |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
