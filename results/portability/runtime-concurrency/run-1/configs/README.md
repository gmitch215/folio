# Configs

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [a.capnp](a.capnp) | 641 | results/20261022-workerd-concurrency/run-1/configs/a.capnp |
| [b.capnp](b.capnp) | 2426 | results/20261022-workerd-concurrency/run-1/configs/b.capnp |
| [c.capnp](c.capnp) | 2161 | results/20261022-workerd-concurrency/run-1/configs/c.capnp |
| [d0.capnp](d0.capnp) | 641 | results/20261022-workerd-concurrency/run-1/configs/d0.capnp |
| [d1.capnp](d1.capnp) | 641 | results/20261022-workerd-concurrency/run-1/configs/d1.capnp |
| [d2.capnp](d2.capnp) | 641 | results/20261022-workerd-concurrency/run-1/configs/d2.capnp |
| [d3.capnp](d3.capnp) | 641 | results/20261022-workerd-concurrency/run-1/configs/d3.capnp |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../../../scripts/README.md).
