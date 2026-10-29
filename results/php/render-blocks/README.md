# Render Blocks

Instrument: [php-blocks.ts](../../../scripts/probe/php-blocks.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [mac-blocks.jsonl](mac-blocks.jsonl) | 49726 | results/20261022-blocks/mac-blocks.jsonl |
| [summary.json](summary.json) | 25927 | results/20261022-blocks/summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
