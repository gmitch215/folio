# Pinned Upstream Kernels

21 library kernels from nine projects: compression, parsing, numerical transforms, encryption, hashing, image coding and a 6502 emulator. Every build and full-memory/native comparison passed. All selected entries retain native fallback under default admission. These are kernels, not full applications.

## Reproduction

Run from the repository root with Node26 and the existing LLVM toolchain. Build the corpus first with `node scripts/research/corpus.ts build build/research/corpus/build.jsonl`. Use a new output path; recorded runs are not overwritten.

```sh
node scripts/research/corpus.ts smoke build/research/corpus/repeat.jsonl
```

Analyze sample records with `node scripts/research/analyze.ts RAW.jsonl SUMMARY.json`; differential/upstream records have their own schemas. Timing requires an otherwise quiet host. The retained source archives in [contexts](../../corpus/contexts/README.md) and [page-reset](../../corpus/page-reset/README.md) preserve the measured source; install pinned dependencies from package.json and use the artifact digests in the upstream records. Source revisions can precede later safety fixes and formatting.

## Artifacts

- [raw.jsonl](raw.jsonl)

`manifest.json` records byte lengths and SHA256 digests. Environment/source hashes, inputs,counts and routing observations are in raw records. Intervals are within-run paired-round bootstrap intervals, not independent-host replication.
