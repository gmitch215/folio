# Consumer Baselines

Instrument: [consumer.ts](../../../scripts/probe/consumer.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [kernel-control.jsonl](kernel-control.jsonl) | 41911 | results/20261020-consumers/kernel-control.jsonl |
| [kernel-control.summary.json](kernel-control.summary.json) | 5849 | results/20261020-consumers/kernel-control.summary.json |
| [machine-core.jsonl](machine-core.jsonl) | 85316 | results/20261020-consumers/machine-core.jsonl |
| [machine-core.summary.json](machine-core.summary.json) | 10650 | results/20261020-consumers/machine-core.summary.json |
| [negative.jsonl](negative.jsonl) | 42148 | results/20261020-consumers/negative.jsonl |
| [negative.summary.json](negative.summary.json) | 5916 | results/20261020-consumers/negative.summary.json |
| [process-abi.jsonl](process-abi.jsonl) | 122737 | results/20261020-consumers/process-abi.jsonl |
| [process-abi.summary.json](process-abi.summary.json) | 15603 | results/20261020-consumers/process-abi.summary.json |
| [tinyimg.jsonl](tinyimg.jsonl) | 605653 | results/20261020-consumers/tinyimg.jsonl |
| [tinyimg.summary.json](tinyimg.summary.json) | 64033 | results/20261020-consumers/tinyimg.summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
