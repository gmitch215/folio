# SQL Effects

Instrument: [php-sql-census.ts](../../../scripts/probe/php-sql-census.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [census.jsonl](census.jsonl) | 1700563 | results/20261022-sqlcensus/census.jsonl |
| [summary.json](summary.json) | 23166 | results/20261022-sqlcensus/summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
