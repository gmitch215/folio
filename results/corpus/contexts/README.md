# Independent Private Contexts

21 fixed-input kernels,16 independent jobs,4 operations per job,7 paired rounds. Native serial, ordinary worker pools and Folio TaskPool at widths1/2/4/8, unbatched and batched. Whole8MiB reset included; full-memory hashing excluded from timing and rerun for each verification pass. Node26.10.0/Ryzen9900X, physical cores4–11,nice19. Full resets make many small jobs slower.

## Reproduction

Run from the repository root with Node26 and the existing LLVM toolchain. Build the corpus first with `node scripts/research/corpus.ts build build/research/corpus/build.jsonl`. Use a new output path; recorded runs are not overwritten.

```sh
node scripts/research/corpus-mechanisms.ts build/research/contexts-repeat 7 4
```

Analyze sample records with `node scripts/research/analyze.ts RAW.jsonl SUMMARY.json`; differential/upstream records have their own schemas. Timing requires an otherwise quiet host. The retained source archives in [contexts](../../corpus/contexts/README.md) and [page-reset](../../corpus/page-reset/README.md) preserve the measured source; install pinned dependencies from package.json and use the artifact digests in the upstream records. Source revisions can precede later safety fixes and formatting.

## Artifacts

- [raw.jsonl](raw.jsonl)
- [source.tar.gz](source.tar.gz)
- [summary.json](summary.json)

`manifest.json` records byte lengths and SHA256 digests. Environment/source hashes, inputs,counts and routing observations are in raw records. Intervals are within-run paired-round bootstrap intervals, not independent-host replication.
