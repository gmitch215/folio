# SMT Scaling

Instrument: [php-intra.ts](../../../scripts/probe/php-intra.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [intra-machine.txt](intra-machine.txt) | 651 | results/20261020-phpwidth-smt/intra-machine.txt |
| [intra-rig.jsonl](intra-rig.jsonl) | 1198090 | results/20261020-phpwidth-smt/intra-rig.jsonl |
| [intra-rig.summary.json](intra-rig.summary.json) | 46511 | results/20261020-phpwidth-smt/intra-rig.summary.json |
| [load-before-intra.txt](load-before-intra.txt) | 71 | results/20261020-phpwidth-smt/load-before-intra.txt |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
