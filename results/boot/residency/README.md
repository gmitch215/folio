# Image Page Residency

Instrument: [page-drop.ts](../../../scripts/probe/page-drop.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [drop-masks.json](drop-masks.json) | 3663 | results/20261022-pagedrop/drop-masks.json |
| [rows.jsonl](rows.jsonl) | 1529574 | results/20261022-pagedrop/rows.jsonl |
| [summary.json](summary.json) | 16747 | results/20261022-pagedrop/summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
