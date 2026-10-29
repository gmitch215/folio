# Initializer Replay Eligibility

21 fixed corpus initializers,three arms,15 measured rounds: conventional initialization,post-instantiation image restore,whole-memory application cache.945 exact samples. All21 bake attempts refuse start sections; post-instantiation restore works. Synthetic counterexamples retain secrets/RNG/stale handles; explicit renewal and rebinding work. Config/asset/driver/module/cache fingerprints must be supplied by the caller. Local exploratory timings overlapped other work; no isolated startup-performance claim.

## Reproduction

Run from the repository root with Node26 and the existing LLVM toolchain. Build the corpus first with `node scripts/research/corpus.ts build build/research/corpus/build.jsonl`. Use a new output path; recorded runs are not overwritten.

```sh
node scripts/research/boot-eligibility.ts build/research/boot-repeat 15
```

Analyze sample records with `node scripts/research/analyze.ts RAW.jsonl SUMMARY.json`; differential/upstream records have their own schemas. Timing requires an otherwise quiet host. The retained source archives in [contexts](../../corpus/contexts/README.md) and [page-reset](../../corpus/page-reset/README.md) preserve the measured source; install pinned dependencies from package.json and use the artifact digests in the upstream records. Source revisions can precede later safety fixes and formatting.

## Artifacts

- [raw.jsonl](raw.jsonl)
- [summary.json](summary.json)

`manifest.json` records byte lengths and SHA256 digests. Environment/source hashes, inputs,counts and routing observations are in raw records. Intervals are within-run paired-round bootstrap intervals, not independent-host replication.
