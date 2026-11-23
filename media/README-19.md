# Differential Guards

Question: do generated programs and guard-refusal fixtures stay equal to native execution on a
second seed, and does a guard ever refuse?

This extends the [differential campaign](../differential/README.md). It runs two seeds with the
same generator and adds a family of counted loops whose 4-byte stores use a stride of 1, 2 and 4
bytes. Strides 1 and 2 overlap at region boundaries, so the disjointness guard refuses them.
Stride 4 does not overlap. Each loop also runs one out-of-range input that traps natively.

## Results

| | Seed 12648430 | Seed 464367618 |
| --- | ---: | ---: |
| Programs | 128 | 128 |
| Comparisons | 6,228 | 6,228 |
| Trapping comparisons | 2,976 | 3,008 |
| Host exceptions | 1,024 | 1,024 |
| Replayed regions | 3,668 | 3,701 |
| Dispatched comparisons | 1,923 | 1,893 |
| Native shared route | 12 | 12 |
| Guard refusals (`guard-failed`) | 12 | 12 |

All 12,456 comparisons match native in complete memory, return value, ordered host effects and
trap or host exception identity, at widths 1, 2, 4 and 8. The earlier campaign reported zero guard
refusals; the overlap family produces 12 per seed and each falls back to speculation with the
native result.

Each seed draws each of the seven grammar shapes between 13 and 30 times. The shapes cover scalar 32-bit load,
rotate, xor and store; 64-bit load, add and store; `memory.copy`; 32-bit and 64-bit float
load and store; saturating float-to-integer conversion; and 16-bit store with a sign-extended byte
load and `clz`. Four input modes cross each shape: a shared destination, an aliased source, a
destination at the page boundary and a trap. The grammar does not generate `memory.fill`,
`memory.init`, atomic operations or SIMD, so those transformations have no generated coverage.

The campaign is finite evidence of equality on these shapes. It is not a proof of correctness for
the transformation.

## Reproduction

```sh
node scripts/research/differential.ts build/research/seed-12648430 128 12648430
node scripts/research/differential.ts build/research/seed-464367618 128 464367618
```

The records ran on an Apple M2 Pro with Node 26.8.2.

## Artifacts

- `seed-12648430.jsonl`, `seed-464367618.jsonl`: raw records.
- `seed-12648430.summary.json`, `seed-464367618.summary.json`: totals as the campaign wrote them.
- `manifest.json`: byte lengths and SHA256 digests.
