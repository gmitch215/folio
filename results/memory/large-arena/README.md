# Large Arena

Instrument: [large-probe.ts](../../../scripts/probe/large-probe.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [cpu.jsonl](cpu.jsonl) | 25061 | results/20261019-b/cpu.jsonl |
| [driver.log](driver.log) | 409 | results/20261019-b/driver.log |
| [exit-code](exit-code) | 2 | results/20261019-b/exit-code |
| [source.tar](source.tar) | 159232 | results/20261019-b/source.tar |
| [summary.json](summary.json) | 12563 | results/20261019-b/summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
