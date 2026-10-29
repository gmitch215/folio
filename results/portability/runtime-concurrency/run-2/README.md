# Run 2

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [calibration.json](calibration.json) | 180 | results/20261022-workerd-concurrency/run-2/calibration.json |
| [samples.jsonl](samples.jsonl) | 96985 | results/20261022-workerd-concurrency/run-2/samples.jsonl |
| [summary.json](summary.json) | 8475 | results/20261022-workerd-concurrency/run-2/summary.json |
| [table.txt](table.txt) | 2013 | results/20261022-workerd-concurrency/run-2/table.txt |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../../scripts/README.md).
