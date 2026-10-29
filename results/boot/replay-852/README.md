# Replay Safety PHP 8.5.2

Instrument: [bake-secrets.ts](../../../scripts/probe/bake-secrets.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [mac-arms.jsonl](mac-arms.jsonl) | 15697 | results/20261022-bakesecrets/mac-arms.jsonl |
| [mac-capture.jsonl](mac-capture.jsonl) | 33219 | results/20261022-bakesecrets/mac-capture.jsonl |
| [mac-replay.jsonl](mac-replay.jsonl) | 58615 | results/20261022-bakesecrets/mac-replay.jsonl |
| [summary.json](summary.json) | 48875 | results/20261022-bakesecrets/summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
