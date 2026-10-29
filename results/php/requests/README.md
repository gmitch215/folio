# Independent Requests

Instrument: [php-concurrent.ts](../../../scripts/probe/php-concurrent.ts).

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [cpu-rig.jsonl](cpu-rig.jsonl) | 735736 | results/20261020-phpparallel/cpu-rig.jsonl |
| [cpu-rig.summary.json](cpu-rig.summary.json) | 95026 | results/20261020-phpparallel/cpu-rig.summary.json |
| [drupal-breakdown-rig.jsonl](drupal-breakdown-rig.jsonl) | 58924 | results/20261020-phpparallel/drupal-breakdown-rig.jsonl |
| [drupal-breakdown-rig.summary.json](drupal-breakdown-rig.summary.json) | 8899 | results/20261020-phpparallel/drupal-breakdown-rig.summary.json |
| [drupal-rig.jsonl](drupal-rig.jsonl) | 444630 | results/20261020-phpparallel/drupal-rig.jsonl |
| [drupal-rig.summary.json](drupal-rig.summary.json) | 31695 | results/20261020-phpparallel/drupal-rig.summary.json |
| [mac-drupal-breakdown.jsonl](mac-drupal-breakdown.jsonl) | 61554 | results/20261020-phpparallel/mac-drupal-breakdown.jsonl |
| [mac-drupal-breakdown.summary.json](mac-drupal-breakdown.summary.json) | 8865 | results/20261020-phpparallel/mac-drupal-breakdown.summary.json |
| [mac-load-before-breakdown.txt](mac-load-before-breakdown.txt) | 65 | results/20261020-phpparallel/mac-load-before-breakdown.txt |
| [memory-rig.jsonl](memory-rig.jsonl) | 4566 | results/20261020-phpparallel/memory-rig.jsonl |
| [memory.summary.json](memory.summary.json) | 4737 | results/20261020-phpparallel/memory.summary.json |
| [rig-load-before-breakdown.txt](rig-load-before-breakdown.txt) | 337 | results/20261020-phpparallel/rig-load-before-breakdown.txt |
| [rig-load-before-cpu.txt](rig-load-before-cpu.txt) | 71 | results/20261020-phpparallel/rig-load-before-cpu.txt |
| [rig-load-before-drupal.txt](rig-load-before-drupal.txt) | 71 | results/20261020-phpparallel/rig-load-before-drupal.txt |
| [rig-machine.txt](rig-machine.txt) | 765 | results/20261020-phpparallel/rig-machine.txt |
| [rig-memory-cpu-folio-1.jsonl](rig-memory-cpu-folio-1.jsonl) | 257 | results/20261020-phpparallel/rig-memory-cpu-folio-1.jsonl |
| [rig-memory-cpu-folio-2.jsonl](rig-memory-cpu-folio-2.jsonl) | 266 | results/20261020-phpparallel/rig-memory-cpu-folio-2.jsonl |
| [rig-memory-cpu-folio-4.jsonl](rig-memory-cpu-folio-4.jsonl) | 284 | results/20261020-phpparallel/rig-memory-cpu-folio-4.jsonl |
| [rig-memory-cpu-folio-8.jsonl](rig-memory-cpu-folio-8.jsonl) | 320 | results/20261020-phpparallel/rig-memory-cpu-folio-8.jsonl |
| [rig-memory-cpu-native-1.jsonl](rig-memory-cpu-native-1.jsonl) | 258 | results/20261020-phpparallel/rig-memory-cpu-native-1.jsonl |
| [rig-memory-cpu-native-2.jsonl](rig-memory-cpu-native-2.jsonl) | 267 | results/20261020-phpparallel/rig-memory-cpu-native-2.jsonl |
| [rig-memory-cpu-native-4.jsonl](rig-memory-cpu-native-4.jsonl) | 285 | results/20261020-phpparallel/rig-memory-cpu-native-4.jsonl |
| [rig-memory-cpu-native-8.jsonl](rig-memory-cpu-native-8.jsonl) | 321 | results/20261020-phpparallel/rig-memory-cpu-native-8.jsonl |
| [rig-memory-drupal-folio-1.jsonl](rig-memory-drupal-folio-1.jsonl) | 262 | results/20261020-phpparallel/rig-memory-drupal-folio-1.jsonl |
| [rig-memory-drupal-folio-2.jsonl](rig-memory-drupal-folio-2.jsonl) | 271 | results/20261020-phpparallel/rig-memory-drupal-folio-2.jsonl |
| [rig-memory-drupal-folio-4.jsonl](rig-memory-drupal-folio-4.jsonl) | 291 | results/20261020-phpparallel/rig-memory-drupal-folio-4.jsonl |
| [rig-memory-drupal-folio-8.jsonl](rig-memory-drupal-folio-8.jsonl) | 328 | results/20261020-phpparallel/rig-memory-drupal-folio-8.jsonl |
| [rig-memory-drupal-native-1.jsonl](rig-memory-drupal-native-1.jsonl) | 263 | results/20261020-phpparallel/rig-memory-drupal-native-1.jsonl |
| [rig-memory-drupal-native-2.jsonl](rig-memory-drupal-native-2.jsonl) | 272 | results/20261020-phpparallel/rig-memory-drupal-native-2.jsonl |
| [rig-memory-drupal-native-4.jsonl](rig-memory-drupal-native-4.jsonl) | 292 | results/20261020-phpparallel/rig-memory-drupal-native-4.jsonl |
| [rig-memory-drupal-native-8.jsonl](rig-memory-drupal-native-8.jsonl) | 329 | results/20261020-phpparallel/rig-memory-drupal-native-8.jsonl |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../scripts/README.md).
