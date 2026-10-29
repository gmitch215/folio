# Replay Safety PHP 8.5.12

Instrument: [bake-secrets.ts](../../../scripts/probe/bake-secrets.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [mac-arms.jsonl](mac-arms.jsonl) | 15668 | results/20261022-bakesecrets-php8512/mac-arms.jsonl |
| [mac-capture.jsonl](mac-capture.jsonl) | 37072 | results/20261022-bakesecrets-php8512/mac-capture.jsonl |
| [mac-census.jsonl](mac-census.jsonl) | 27541 | results/20261022-bakesecrets-php8512/mac-census.jsonl |
| [mac-replay.jsonl](mac-replay.jsonl) | 58589 | results/20261022-bakesecrets-php8512/mac-replay.jsonl |
| [mac-sweep.jsonl](mac-sweep.jsonl) | 9773 | results/20261022-bakesecrets-php8512/mac-sweep.jsonl |
| [summary.json](summary.json) | 74703 | results/20261022-bakesecrets-php8512/summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
