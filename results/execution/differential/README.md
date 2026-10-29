# Seeded Differential Execution

128 generated WAT programs plus guard fixtures;6168 comparisons at widths1/2/4/8. Complete memory, returns, traps and ordered host effects match. Grammar covers seven scalar/bulk shapes and varied dependencies/unaligned/bounds/trap cases. Thresholds are zero for coverage only. This finite campaign is not a proof for all Wasm instructions or programs.

## Reproduction

Run from the repository root with Node26 and the existing LLVM toolchain. Build the corpus first with `node scripts/research/corpus.ts build build/research/corpus/build.jsonl`. Use a new output path; recorded runs are not overwritten.

```sh
node scripts/research/differential.ts build/research/differential-repeat 128 12648430
```

Analyze sample records with `node scripts/research/analyze.ts RAW.jsonl SUMMARY.json`; differential/upstream records have their own schemas. Timing requires an otherwise quiet host. The retained source archives in [contexts](../../corpus/contexts/README.md) and [page-reset](../../corpus/page-reset/README.md) preserve the measured source; install pinned dependencies from package.json and use the artifact digests in the upstream records. Source revisions can precede later safety fixes and formatting.

## Artifacts

- [raw.jsonl](raw.jsonl)
- [summary.json](summary.json)

`manifest.json` records byte lengths and SHA256 digests. Environment/source hashes, inputs,counts and routing observations are in raw records. Intervals are within-run paired-round bootstrap intervals, not independent-host replication.
