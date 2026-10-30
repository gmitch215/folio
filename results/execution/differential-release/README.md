# Differential Release Record

Question: does the code of the release, with the iteration route in it, still equal native execution on the
seeded differential campaign and on the generated iteration family?

Two runs of `scripts/research/differential.ts` on the final code, on an Apple M2 Pro with Node 26.8.2 (load
average 4 to 6 from other work, which affects no result because the check compares outputs, not times).

## Results

**Standard campaign.** Seed 12648430, 128 generated programs and the guard fixtures, widths 1, 2, 4 and 8:
6,228 comparisons, all equal to native in complete memory, return value, ordered host effects and trap or
host exception identity. 2,976 comparisons trap natively, 1,024 end in a host exception, 3,668 regions
replayed, 1,923 comparisons dispatched, 12 took the native shared route and 12 fell back after a guard
refusal. These counts equal the first seed of the [differential guards](../differential-guards/README.md)
record, which ran the same campaign on the code before the iteration route.

**Iteration family.** 200 seeds from base 12648430, 8 shapes each (disjoint, read-after-write,
write-after-read, write-after-write, framed, frame-carried, trapping and mixed), 1,600 programs at widths 2, 4
and 8: 9,600 comparisons against the serial program, all equal. Each comparison runs the program through the
iteration executor and compares complete memory outside the stack zone and the arena, the return value and
the trap. The family places its hazards among the iterations of the first batch.

Neither run is a proof for all Wasm instructions or programs.

## Reproduction

Run from the repository root with Node 26 and the existing LLVM toolchain. Use new output paths; recorded runs are
not overwritten.

```sh
node scripts/research/differential.ts OUTPUT_DIRECTORY 128 12648430
node scripts/research/differential.ts iteration OUTPUT_DIRECTORY 200
```

## Artifacts

- `raw.jsonl`, `summary.json`: the standard campaign.
- `iteration-raw.jsonl`, `iteration-summary.json`: the iteration family.
- `manifest.json`: byte lengths and SHA256 digests.
