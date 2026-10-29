# Static Admission

Instrument: [admission-calibration.ts](../../../scripts/probe/admission-calibration.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [admission-calibration.jsonl](admission-calibration.jsonl) | 42056 | results/20261020-regress/admission-calibration.jsonl |
| [admission-calibration.summary.json](admission-calibration.summary.json) | 10530 | results/20261020-regress/admission-calibration.summary.json |
| [admission-sites.jsonl](admission-sites.jsonl) | 61559 | results/20261020-regress/admission-sites.jsonl |
| [bypass-decision.jsonl](bypass-decision.jsonl) | 141359 | results/20261020-regress/bypass-decision.jsonl |
| [bypass-decision.probe.ts.txt](bypass-decision.probe.ts.txt) | 3113 | results/20261020-regress/bypass-decision.probe.ts.txt |
| [bypass-decision.summary.json](bypass-decision.summary.json) | 17949 | results/20261020-regress/bypass-decision.summary.json |
| [kernel-control-repeat.jsonl](kernel-control-repeat.jsonl) | 118111 | results/20261020-regress/kernel-control-b.jsonl |
| [kernel-control-repeat.summary.json](kernel-control-repeat.summary.json) | 8640 | results/20261020-regress/kernel-control-b.summary.json |
| [kernel-control.jsonl](kernel-control.jsonl) | 76735 | results/20261020-regress/kernel-control.jsonl |
| [kernel-control.summary.json](kernel-control.summary.json) | 11094 | results/20261020-regress/kernel-control.summary.json |
| [machine-core.jsonl](machine-core.jsonl) | 155878 | results/20261020-regress/machine-core.jsonl |
| [machine-core.summary.json](machine-core.summary.json) | 20932 | results/20261020-regress/machine-core.summary.json |
| [negative.jsonl](negative.jsonl) | 76759 | results/20261020-regress/negative.jsonl |
| [negative.summary.json](negative.summary.json) | 11138 | results/20261020-regress/negative.summary.json |
| [old-build-src.sha256](old-build-src.sha256) | 1391 | results/20261020-regress/old-build-src.sha256 |
| [old-build-src.tar.gz](old-build-src.tar.gz) | 52137 | results/20261020-regress/old-build-src.tar.gz |
| [php-render.jsonl](php-render.jsonl) | 19699 | results/20261020-regress/php-render.jsonl |
| [php-render.summary.json](php-render.summary.json) | 5837 | results/20261020-regress/php-render.summary.json |
| [php-workloads.jsonl](php-workloads.jsonl) | 608537 | results/20261020-regress/php-workloads.jsonl |
| [php-workloads.summary.json](php-workloads.summary.json) | 93045 | results/20261020-regress/php-workloads.summary.json |
| [process-abi-repeat.jsonl](process-abi-repeat.jsonl) | 211227 | results/20261020-regress/process-abi-b.jsonl |
| [process-abi-repeat.summary.json](process-abi-repeat.summary.json) | 8810 | results/20261020-regress/process-abi-b.summary.json |
| [process-abi.jsonl](process-abi.jsonl) | 223160 | results/20261020-regress/process-abi.jsonl |
| [process-abi.summary.json](process-abi.summary.json) | 30857 | results/20261020-regress/process-abi.summary.json |
| [small-trips-repeat.jsonl](small-trips-repeat.jsonl) | 161011 | results/20261020-regress/small-trips-b.jsonl |
| [small-trips-repeat.summary.json](small-trips-repeat.summary.json) | 11365 | results/20261020-regress/small-trips-b.summary.json |
| [small-trips.jsonl](small-trips.jsonl) | 298828 | results/20261020-regress/small-trips.jsonl |
| [small-trips.summary.json](small-trips.summary.json) | 40919 | results/20261020-regress/small-trips.summary.json |
| [tinyimg.jsonl](tinyimg.jsonl) | 942893 | results/20261020-regress/tinyimg.jsonl |
| [tinyimg.summary.json](tinyimg.summary.json) | 129712 | results/20261020-regress/tinyimg.summary.json |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
