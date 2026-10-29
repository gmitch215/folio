# Work Span Validation

Instrument: [worksp.ts](../../../scripts/probe/worksp.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [controls.jsonl](controls.jsonl) | 308397 | results/20261020-worksp2/controls.jsonl |
| [controls.summary.json](controls.summary.json) | 67420 | results/20261020-worksp2/controls.summary.json |
| [drupal-coarse.jsonl](drupal-coarse.jsonl) | 242762 | results/20261020-worksp2/drupal-coarse.jsonl |
| [drupal-coarse.summary.json](drupal-coarse.summary.json) | 110909 | results/20261020-worksp2/drupal-coarse.summary.json |
| [drupal-fine.jsonl](drupal-fine.jsonl) | 81692 | results/20261020-worksp2/drupal-fine.jsonl |
| [drupal-fine.summary.json](drupal-fine.summary.json) | 38911 | results/20261020-worksp2/drupal-fine.summary.json |
| [validation.jsonl](validation.jsonl) | 3183 | results/20261020-worksp2/validation.jsonl |
| [validation.summary.json](validation.summary.json) | 472 | results/20261020-worksp2/validation.summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
