# Crossover and Guard Costs

10 synthetic cells:5 compute sizes,3 stream sizes,2 conflicts. Nine paired rounds, widths1/2/4/8, automatic, forced tracked and manually partitioned native execution where valid. One copied-memory runAll diagnostic changes the API boundary too, so it is not an isolated backing-only ablation. Full-memory equality checked outside timing. Node26.10.0/Ryzen9900X,physical cores4–11,nice19.

## Reproduction

Run from the repository root with Node26 and the existing LLVM toolchain. Build the corpus first with `node scripts/research/corpus.ts build build/research/corpus/build.jsonl`. Use a new output path; recorded runs are not overwritten.

```sh
node scripts/research/crossover.ts build/research/crossover-repeat 9
```

Analyze sample records with `node scripts/research/analyze.ts RAW.jsonl SUMMARY.json`; differential/upstream records have their own schemas. Timing requires an otherwise quiet host. The retained source archives in [contexts](../../corpus/contexts/README.md) and [page-reset](../../corpus/page-reset/README.md) preserve the measured source; install pinned dependencies from package.json and use the artifact digests in the upstream records. Source revisions can precede later safety fixes and formatting.

## Artifacts

- [raw.jsonl](raw.jsonl)
- [summary.json](summary.json)

`manifest.json` records byte lengths and SHA256 digests. Environment/source hashes, inputs,counts and routing observations are in raw records. Intervals are within-run paired-round bootstrap intervals, not independent-host replication.
