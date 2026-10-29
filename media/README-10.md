# Graded Conflicts

Question: how does speculative execution change as the share of conflicting regions and the work
per region vary?

A batch of 64 `mix` calls from the fixture module runs as one ordered sequence. In each cell a
fraction of the calls updates one shared word, so each of them reads what the previous one wrote
and must replay; the rest update distinct words. The fraction takes six values (0, 1/16, 1/8, 1/4,
1/2, 1) and the work per call takes three (16, 1024 and 65,536 rounds, about 0.1, 1.2 and 76
microseconds on the Ryzen machine). Arms are native, forced speculation at widths 2, 4 and 8, and
the default route at width 8, in 9 paired rounds after 2 warmups. Every sample compares complete
memory with the native result. The study replaces the two fixed conflict cells of the
[crossover sweep](../crossover/README.md) with a graded set.

## Results

Eight-worker forced speculation, paired median speedup over native, 65,536 rounds per call:

| Conflicting calls | Ryzen | M2 Pro |
| ---: | ---: | ---: |
| 0 | 3.50x | 3.54x |
| 1/16 | 2.81x | 3.05x |
| 1/8 | 2.09x | 2.31x |
| 1/4 | 1.65x | 1.77x |
| 1/2 | 1.11x | 1.24x |
| all | 0.74x | 0.77x |

Break-even lies between half and all of the calls conflicting at this region size. At 1,024 rounds
the best cell is 0.26x on the Ryzen machine (0.23x on the M2 Pro) with no conflicts, falling to
0.09x with all conflicting. At 16 rounds every cell is 0.02x or lower. Below about 76 microseconds
per call, dispatch and tracking cost more than the work they distribute, whether or not the calls
conflict.

Ordered validation is not the limiting cost. Its share of wall time is at most 0.3% in the
65,536 round cells and at most 2.1% in any cell. The default route at width 8 gives similar results
to forced speculation in every cell. The two machines agree to within about 11% in every 65,536
round cell.

Admission defaults are unchanged. The measured crossover is consistent with the existing floor of
200,000 estimated work units, and the data does not support lowering it.

## Reproduction

```sh
node scripts/research/graded.ts build/research/graded 9
node scripts/research/analyze.ts build/research/graded/raw.jsonl summary.json
```

The Ryzen record ran through `scripts/research/matched.sh` with `nice -n 19`, cores 4 to 11 and a
shared timing lock. The M2 Pro record ran unpinned on macOS. The raw files here hold the graded
rows only; the routing rows of the same run are in [adaptive routing](../adaptive-routing/README.md).

## Artifacts

- `ryzen.jsonl`, `m2.jsonl`: raw records, 810 samples each (18 cells, 5 arms, 9 rounds).
- `ryzen.summary.json`, `m2.summary.json`: paired summaries, including validation and commit time.
- `manifest.json`: byte lengths and SHA256 digests.

Sources are identified by SHA256 in each environment row. The Ryzen source archive is in
[reset-policies](../../corpus/reset-policies/source.tar.gz).
