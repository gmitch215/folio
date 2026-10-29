# Work Span Pilot

Instrument: [worksp.ts](../../../scripts/probe/worksp.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [count.jsonl](count.jsonl) | 16238 | results/20261020-worksp/count.jsonl |
| [count.summary.json](count.summary.json) | 9706 | results/20261020-worksp/count.summary.json |
| [refcount-verification.json](refcount-verification.json) | 1612 | results/20261020-worksp/refcount-verification.json |
| [trace-drupal.jsonl](trace-drupal.jsonl) | 23106 | results/20261020-worksp/trace-drupal.jsonl |
| [trace-drupal.summary.json](trace-drupal.summary.json) | 8969 | results/20261020-worksp/trace-drupal.summary.json |
| [trace-small.jsonl](trace-small.jsonl) | 52675 | results/20261020-worksp/trace-small.jsonl |
| [trace-small.summary.json](trace-small.summary.json) | 25181 | results/20261020-worksp/trace-small.summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
