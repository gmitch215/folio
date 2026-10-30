# Ordinary Worker Lanes

Question: can ordinary Workers (no Durable Objects) joined by service bindings run CPU work in
parallel, and does sending only a region's bytes recover the speed that a full snapshot copy loses?

This is a feasibility probe, not a Folio execution. A coordinator Worker and four lane Workers ran a
known kernel, and no program, plan or validation of Folio's was involved. The
[method](../../../experiments/rpc/METHOD.md) fixed both decision rules before each run.

## Method

Five scripts on the Free account (a coordinator and four lanes, bound by service bindings), deployed,
measured and deleted per run. The account's Workers, Durable Object namespaces, KV, R2 and D1 ids were
the same afterward. In the stage B run the R2 listing was unavailable at the start (read as `null`) and
empty at the end, which tripped the driver's equality assertion after all data was written; scripts,
namespaces, KV and D1 were identical. Wall time is read by the coordinator around awaited calls, because a
Worker's clock advances only on I/O. CPU time was not measured. One coordinator location, 14 paired
rounds after 2 warmups, cell order rotating every round.

Stage A (`stage-a-*`): each lane runs a CPU loop of calibrated length (about 4 ms per call, under the 10 ms
Free CPU cap). The coordinator awaits `k` lanes at once, six times in a row, and a cell's compute time is
its wall minus the wall of the same cell with an empty loop. An earlier run with a loop of about 1 ms
could not separate overlap from jitter and is not reported.

Stage B (`stage-b-*`): a Wasm kernel rewrites a 16 KiB partition in place. Four partitions sit in an arena
of 128 KiB, 1 MiB or 8 MiB (zero-filled outside the partitions). Four waves per cell, each feeding the
previous wave's output forward. `serial` runs the four partitions on one lane that keeps them resident,
`full` sends every lane the whole arena each wave, `range` sends each lane its partition each wave, and
`retained` sends the partition once.

## Results

**Stage A, overlap.** Wall in ms, median with the range over 14 rounds.

| Lanes at once | With the loop | Empty loop | Compute |
| --- | --- | --- | --- |
| 1 | 35.5 (33 to 42) | 13 (10 to 19) | 22.5 |
| 2 | 39.5 (36 to 71) | | |
| 4 | 51.5 (42 to 64) | 19.5 (15 to 24) | 32 |

The serialization index (compute with four lanes over compute with one) is 1.42, against 4.0 for fully
serialized lanes. The rule fixed before the run called overlap established at 1.5 or less, so the margin is
thin. Four distinct lane instances answered, every call returned 200, and the effective overlap is about
2.8x. Fetching a lane's workers.dev URL from inside a Worker returned 404 in every sample, so that route
is unavailable here.

**Stage B, transfer.** Wall in ms, median; speedup is the paired median over the same round's `serial`
run, with the range over rounds. Bytes are what the coordinator sent per request, and every mode returned
262,144 bytes.

| Arena | Mode | Wall | Speedup over serial | Bytes sent | Failed requests |
| --- | --- | --- | --- | --- | --- |
| 128 KiB | serial | 113 | | 65,536 | 1 of 14 |
| 128 KiB | full | 43.5 | 2.64x (1.74 to 2.92) | 2,097,152 | 0 |
| 128 KiB | range | 41 | 2.71x (2.05 to 3.47) | 262,144 | 0 |
| 128 KiB | retained | 37.5 | 2.82x (2.22 to 3.70) | 65,536 | 0 |
| 1 MiB | serial | 109 | | 65,536 | 0 |
| 1 MiB | full | 110 | 1.03x (0.77 to 1.27) | 16,777,216 | 1 |
| 1 MiB | range | 42 | 2.55x (1.86 to 3.42) | 262,144 | 0 |
| 1 MiB | retained | 40 | 2.97x (1.89 to 3.82) | 65,536 | 1 |
| 8 MiB | serial | 114.5 | | 65,536 | 0 |
| 8 MiB | full | 510 | 0.22x (0.12 to 0.29) | 134,217,728 | 3 |
| 8 MiB | range | 40 | 2.88x (1.72 to 3.70) | 262,144 | 0 |
| 8 MiB | retained | 38 | 3.11x (2.27 to 3.88) | 65,536 | 1 |

- **The rule fixed before the run holds.** At 8 MiB `range` and `retained` are 2.88x and 3.11x faster
  than `serial`, every ok row's digest equals the serial run's of the same round, the payload is 0.2% and
  0.05% of `full`, and `full` is slower than `range`.
- **Bytes are the lever.** `full` falls from 2.64x at 128 KiB to 1.03x at 1 MiB and 0.22x at 8 MiB, which
  matches the managed backend's later-operation cost in the
  [operations study](../operations/README.md). `range` and `retained` stay at 2.6x to 3.1x at every size,
  close to the 2.8x of stage A.
- **Seven of 168 requests returned 503**, three of them in `full` at 8 MiB and the rest one each in four
  other cells. The cause was not isolated. A failed request is not in the medians; no digest differed.

## Limits

- **The ranges were declared.** The kernel touches exactly its partition, so the coordinator knew the
  footprint before the call. Folio does not know a region's footprint before it runs, except for kernels a
  guard has proven, and a wrong range would give a wrong result. Nothing here shows how to get
  footprints for general programs.
- **No Folio code ran.** There was no conflict, rollback, replay or ordered validation, and the four
  partitions were disjoint by construction.
- **Wall only.** No CPU, billing or per-isolate placement was measured, so the 2.8x is an observed wall
  overlap and says nothing about CPU time or price.
- **The platform documentation says service-bound Workers run on the same thread of the same server by
  default,** and a local workerd process gave 0.99x to 1.01x for a similar shape. The deployed result
  here does not match either, and the reason was not isolated: placement may vary by account, location
  or time.
- One account, one coordinator location, 14 rounds, four lanes, a 4 ms kernel and 16 KiB partitions.
  Zero-filled arena bytes could be handled specially by the platform.

## Reproduction

```sh
node experiments/rpc/prepare.ts
node experiments/rpc/run.ts
FOLIO_RPC_STAGE=xfer node experiments/rpc/run.ts
```

## Artifacts

- `stage-a-run.json`, `stage-a-calibration.json`, `stage-a-samples.json`, `stage-a-summary.json`: the
  overlap run.
- `stage-b-run.json`, `stage-b-calibration.json`, `stage-b-samples.json`, `stage-b-summary.json`: the
  transfer run.
- `source.tar.gz`: `experiments/rpc` as run.
- `manifest.json`: byte lengths and SHA256 digests.
