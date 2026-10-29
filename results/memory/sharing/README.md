# Backing Store Identity

Instrument: [sharing-probe.mjs](../../../scripts/probe/sharing-probe.mjs).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [cpu.jsonl](cpu.jsonl) | 19596 | results/20261019/cpu.jsonl |
| [driver.log](driver.log) | 407 | results/20261019/driver.log |
| [exit-code](exit-code) | 2 | results/20261019/exit-code |
| [sharing-copied-0.jsonl](sharing-copied-0.jsonl) | 275 | results/20261019/sharing-copied-0.jsonl |
| [sharing-copied-1.jsonl](sharing-copied-1.jsonl) | 275 | results/20261019/sharing-copied-1.jsonl |
| [sharing-copied-2.jsonl](sharing-copied-2.jsonl) | 275 | results/20261019/sharing-copied-2.jsonl |
| [sharing-large.jsonl](sharing-large.jsonl) | 413 | results/20261019/sharing-large.jsonl |
| [sharing-shared-0.jsonl](sharing-shared-0.jsonl) | 410 | results/20261019/sharing-shared-0.jsonl |
| [sharing-shared-1.jsonl](sharing-shared-1.jsonl) | 410 | results/20261019/sharing-shared-1.jsonl |
| [sharing-shared-2.jsonl](sharing-shared-2.jsonl) | 410 | results/20261019/sharing-shared-2.jsonl |
| [source.tar](source.tar) | 122368 | results/20261019/source.tar |
| [summary.json](summary.json) | 13018 | results/20261019/summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
