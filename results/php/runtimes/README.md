# PHP Runtime Comparison

Instrument: [php-regen.ts](../../../scripts/probe/php-regen.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [bun.jsonl](bun.jsonl) | 2762 | results/20261022-bun-drupal/bun.jsonl |
| [compare.json](compare.json) | 3125 | results/20261022-bun-drupal/compare.json |
| [node.jsonl](node.jsonl) | 2737 | results/20261022-bun-drupal/node.jsonl |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
