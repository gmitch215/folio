# Configs

Historical v1 evidence. Original file names, sizes and SHA256 digests are retained in
[the evidence index](../../../../index.json). The recorded bytes are unchanged.
Dates, runtime versions, sample counts and routing observations are in the records.

| File | Bytes | Original Record |
| --- | ---: | --- |
| [single.capnp](single.capnp) | 641 | results/20261022-workerd-concurrency/run-2/configs/a.capnp |
| [front.capnp](front.capnp) | 2426 | results/20261022-workerd-concurrency/run-2/configs/b.capnp |
| [sockets.capnp](sockets.capnp) | 2161 | results/20261022-workerd-concurrency/run-2/configs/c.capnp |
| [processes-0.capnp](processes-0.capnp) | 641 | results/20261022-workerd-concurrency/run-2/configs/d0.capnp |
| [processes-1.capnp](processes-1.capnp) | 641 | results/20261022-workerd-concurrency/run-2/configs/d1.capnp |
| [processes-2.capnp](processes-2.capnp) | 641 | results/20261022-workerd-concurrency/run-2/configs/d2.capnp |
| [processes-3.capnp](processes-3.capnp) | 641 | results/20261022-workerd-concurrency/run-2/configs/d3.capnp |

## Reproduction

From the repository root, run `bun scripts/analyze/run.ts` to regenerate supported summaries.
Source archives retain the measured implementation. Local and deployed records remain separate;
use the record's environment and method before comparing runs. External consumer probes require
the paths described in [scripts/README.md](../../../../../scripts/README.md).
