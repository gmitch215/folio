# Task Runtime Compatibility

Instrument: [tasks-runtime.ts](../../../scripts/probe/tasks-runtime.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [bun.json](bun.json) | 1330 | results/20261022-tasks-runtime/bun.json |
| [node24.json](node24.json) | 1334 | results/20261022-tasks-runtime/node24.json |
| [node26.json](node26.json) | 1333 | results/20261022-tasks-runtime/node26.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
