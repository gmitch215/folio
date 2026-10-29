# Backing Ablation

Question: with the call boundary held equal, does a shared base memory run faster than a copied one?

The [crossover sweep](../crossover/README.md) compared a shared-memory arm with a copied-snapshot arm
through different entry points, so the comparison changed the boundary as well as the backing. Here
both backings run the same `runAll` call list with forced speculation. The two modules have the same
instructions and memory size; only the import's shared flag differs. Cells use 64 `mix` calls at
1,024 and 65,536 rounds, with none and a quarter of the calls updating one shared word. Arms are
native and both backings at widths 2, 4 and 8, in 9 paired rounds after 2 warmups. Every sample
compares complete memory with the native result.

## Results

Paired median speedup over native, shared against copied:

| Cell | Width | Ryzen | M2 Pro |
| --- | ---: | --- | --- |
| 65,536 rounds, no conflicts | 4 | 1.22x, 1.21x | 2.74x, 2.67x |
| 65,536 rounds, no conflicts | 8 | 2.24x, 2.12x | 3.40x, 3.04x |
| 65,536 rounds, a quarter conflicting | 4 | 1.56x, 1.75x | 1.71x, 1.65x |
| 65,536 rounds, a quarter conflicting | 8 | 1.48x, 1.67x | 1.87x, 1.86x |

At 1,024 rounds every cell is 0.22x or lower with either backing. Across the 24 cells of each machine
the two backings differ by up to about 20% in either direction, and neither is consistently faster.
With the boundary equal, backing is not the limiting cost of speculation. The overlays, dispatch and
validation are the same work in both.

The Ryzen speedups here are lower than in [graded conflicts](../graded-conflicts/README.md) for the
same cell (2.24x against 3.50x at width 8 with no conflicts). This run keeps six pools and 28 worker
threads open and rotates seven arms, which the graded run does not. Compare the two backings inside
this run and not against the graded figures.

## Reproduction

```sh
node scripts/research/backing.ts build/research/backing 9
node scripts/research/analyze.ts build/research/backing/raw.jsonl summary.json
```

`scripts/research/backing.sh` runs it on the Linux rig under a timing lock with `nice -n 19` and cores 4
to 11. The M2 Pro record ran unpinned on macOS.

## Artifacts

- `ryzen.jsonl`, `m2.jsonl`: raw records, 252 samples each (4 cells, 7 arms, 9 rounds).
- `ryzen.summary.json`, `m2.summary.json`: paired summaries.
- `source.tar.gz`: the source the Ryzen run used.
- `manifest.json`: byte lengths and SHA256 digests.
