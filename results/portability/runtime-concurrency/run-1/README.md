# Run 1

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [calibration.json](calibration.json) | 179 | results/20261022-workerd-concurrency/run-1/calibration.json |
| [samples.jsonl](samples.jsonl) | 97256 | results/20261022-workerd-concurrency/run-1/samples.jsonl |
| [summary.json](summary.json) | 7726 | results/20261022-workerd-concurrency/run-1/summary.json |
| [table.txt](table.txt) | 1782 | results/20261022-workerd-concurrency/run-1/table.txt |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../../scripts/README.md).
