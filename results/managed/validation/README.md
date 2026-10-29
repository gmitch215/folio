# Validation

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [lifecycle.json](lifecycle.json) | 82056 | experiments/managed/results-local-consolidated.json |
| [complete.json](complete.json) | 82099 | experiments/managed/results-local-final.json |
| [pilot.json](pilot.json) | 62274 | experiments/managed/results-local.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
