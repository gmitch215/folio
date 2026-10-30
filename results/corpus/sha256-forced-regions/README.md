# SHA-256 Forced Regions

Question: forced admission splits the SHA-256 kernel into 67,600 regions per call and runs 1,054x slower
than native (see [forced-admission-complete](../forced-admission-complete/README.md)). What are the
regions, and why do they not pay?

## Method

No timing run. `inspect.ts` calls `prepare(bytes, { minimumRegionWork: 0 })` on the SHA-256 corpus
artifact (17 regions from 20 pure functions, 7 instrumented controllers), dumps the coordinator, worker
and original modules as named WAT, and replays `initialize` and `entry` through a host model that follows
`src/coordinator.ts`: enqueue, flush at width times 16, flush on a barrier, settle, and poll every 1,024
polls. A batch of one runs at its owner. The harness counts region calls and does not model read sets.
Checks: 67,600 entry dispatches (the figure in `forced-admission-complete`), the coordinator's output
memory equals the native digest, and both return 32. The per-call arithmetic uses the recorded medians of
`forced-admission-complete` and [graded-conflicts](../../execution/graded-conflicts/README.md). The
library copy in `source.tar.gz` adds a WAT dump, an `index` field on the `observed` callback and an export
of `prepareTracked`.

## Results

**What the 67,600 regions are.** One per input byte (65,536), one per completed 64-byte block that resets
the buffer (1,024), one per transform (1,025, the last from padding) and 15 in finalization. That is 1.03
regions per input byte. The 16 words per block and the 64 rounds of a transform create no regions. They
run inside the coordinator's copy of `sha256_transform`, which is not a region because its original body
reads and writes `__stack_pointer`, and `pureNodes` in `src/extract.ts` excludes `GlobalGet`.

**Most regions run alone.** The coordinator reads the buffer length from memory on every byte, and while a
region is queued each controller memory access first joins it. So 65,540 regions run at their owner after
one join each, which skips the conflict check, and only 2,060 run in batches: 1,023 pairs of a block reset
with the next byte, and one batch of 14 at the end of finalization. At width 8 the harness counts 66,565
flushes, with batch sizes 1 (65,540 times), 2 (1,024 times) and 14 (once).

**None of the batches conflicts.** A block reset writes the buffer length and bit-count words, and a byte
region reads one input byte and writes one context byte at an index passed as an argument, so it never reads
the length word. In the batch of 14, the zero fills read no memory and write below offset 64, and the length
region reads offsets 64 and 72, which no zero fill writes. The 12 raw SHA-256 samples of the forced study
report `replayed: 0` at widths 1, 2, 4 and 8, which agrees.

**The cost per region.** Native work is 0.21335 ms per call, 3.16 ns per region. Width 8 takes 225.27 ms,
3.33 microseconds per region; widths 2 and 4 take 222.98 and 213.46 ms, within 6% of width 8. The wall is
1,055 times the work, which is the 1,054x slowdown. The estimate charges every region a negative net (mean
-7,582, worst -230,328), and with the access cost set to zero the mean compute of 3.2 units per region is still
about 60,000 times below the 200,000 floor. In the graded study a call of 1,024 rounds (1.21 microseconds of
work) costs 3.40 microseconds more than native at width 8, and one of 16 rounds (0.103 microsecond) costs
9.64 microseconds more. A SHA-256 region carries 33 to 383 times less work than those calls.

## Limits

- The 3.33 microseconds per region is wall divided by regions. It is an upper bound on dispatch cost
  because the wall also includes the coordinator's transform code, and the data does not separate the two.
  Splitting the 225 ms between joins and controller code needs a timing run that removes the joins.
- The harness models the queue, the join and the batch shape. It does not trace read or write sets, so zero
  replays rests on the footprint argument and the raw samples.
- Widths 2 and 4 were not run through the harness. The batch shape there is inferred, because the queue
  does not reach width times 16.
- The loops of `sha256_final` are placed by position in the coordinator's WAT and call-site depth, and not
  characterized further.

## Reproduction

From the repository root, after building the corpus (`scripts/research/corpus.ts build`):

```sh
mkdir -p build/research/sha256-forced
tar -xzf results/corpus/sha256-forced-regions/source.tar.gz -C build/research/sha256-forced
node build/research/sha256-forced/inspect.ts
node build/research/sha256-forced/table.ts
node build/research/sha256-forced/arith.ts
```

## Artifacts

- `inspect.json`: the region and function figures used above.
- `sha256.coordinator.wat`, `sha256.worker.wat`, `sha256.original.wat`: the named WAT.
- `source.tar.gz`: the harness, the arithmetic scripts and the library copy.
- `manifest.json`: byte lengths and SHA256 digests.
