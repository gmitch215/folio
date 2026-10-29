# Changed-Page Reset

Same independent operations and timing method as contexts. The fixed deterministic entry is run once to identify changed64KiB pages, then initialized state is restored. Only those pages are reset per operation. Every verification operation still compares all8MiB and returns. This is a corpus-specific specialization for unchanged code/input/host state, not a generic dirty-memory tracker or automatic extraction. Each run has its own matched native baseline.

## Reproduction

Run from the repository root with Node26 and the existing LLVM toolchain. Build the corpus first with `node scripts/research/corpus.ts build build/research/corpus/build.jsonl`. Use a new output path; recorded runs are not overwritten.

```sh
FOLIO_CORPUS_RESET=pages node scripts/research/corpus-mechanisms.ts build/research/pages-repeat 7 4
```

Analyze sample records with `node scripts/research/analyze.ts RAW.jsonl SUMMARY.json`; differential/upstream records have their own schemas. Timing requires an otherwise quiet host. The retained source archives in [contexts](../../corpus/contexts/README.md) and [page-reset](../../corpus/page-reset/README.md) preserve the measured source; install pinned dependencies from package.json and use the artifact digests in the upstream records. Source revisions can precede later safety fixes and formatting.

## Artifacts

- [raw.jsonl](raw.jsonl)
- [source.tar.gz](source.tar.gz)
- [summary.json](summary.json)

`manifest.json` records byte lengths and SHA256 digests. Environment/source hashes, inputs,counts and routing observations are in raw records. Intervals are within-run paired-round bootstrap intervals, not independent-host replication.

A repeat of this study on the same machine, with three reset policies in one session, is in [reset policies](../reset-policies/README.md). It reports 4.80x for AES-CBC decrypt at eight batched workers where this record reports 7.42x; native and one-worker arms agree between the runs.
