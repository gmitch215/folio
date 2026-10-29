# Single-Entry Admission

One upstream entry per operation, native versus default Folio widths 1/2/4/8, nine paired rounds on Node26.8.2/M2 Pro. Zero default worker dispatch. Short microsecond entries have substantial timing uncertainty. Local exploratory timings overlapped other research work; do not use them as isolated crossover estimates.

## Reproduction

Run from the repository root with Node26 and the existing LLVM toolchain. Build the corpus first with `node scripts/research/corpus.ts build build/research/corpus/build.jsonl`. Use a new output path; recorded runs are not overwritten.

```sh
node scripts/research/corpus-serial.ts build/research/serial-repeat 9
```

Analyze sample records with `node scripts/research/analyze.ts RAW.jsonl SUMMARY.json`; differential/upstream records have their own schemas. Timing requires an otherwise quiet host. The retained source archives in [contexts](../../corpus/contexts/README.md) and [page-reset](../../corpus/page-reset/README.md) preserve the measured source; install pinned dependencies from package.json and use the artifact digests in the upstream records. Source revisions can precede later safety fixes and formatting.

## Artifacts

- [raw.jsonl](raw.jsonl)
- [summary.json](summary.json)

`manifest.json` records byte lengths and SHA256 digests. Environment/source hashes, inputs,counts and routing observations are in raw records. Intervals are within-run paired-round bootstrap intervals, not independent-host replication.
