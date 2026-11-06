# Capacity, Local: Method

## Procedure

1. Build the Wasm modules and the backing, then run the matrix into a fresh study directory. The default output is `FOLIO_ELASTIC_STUDY`, which defaults to this directory. Use a fresh directory for any repeat, because the scripts overwrite `raw.json`.

   ```sh
   FOLIO_ELASTIC_STUDY=/path/to/fresh/capacity-local node scripts/probe/elastic/run.ts
   FOLIO_ELASTIC_STUDY=/path/to/fresh/capacity-local FOLIO_ELASTIC_FULL_SCAN=1 FOLIO_ELASTIC_OUTPUT=/path/to/fresh/capacity-local/full-scan.json node scripts/probe/elastic/run.ts
   FOLIO_ELASTIC_STUDY=/path/to/fresh/capacity-local node scripts/probe/elastic/compiled.ts
   FOLIO_ELASTIC_STUDY=/path/to/fresh/capacity-local node scripts/probe/elastic/native.ts
   FOLIO_ELASTIC_STUDY=/path/to/fresh/capacity-local node scripts/research/elastic-verify-backing.mjs
   FOLIO_ELASTIC_STUDY=/path/to/fresh/capacity-local node scripts/research/elastic-analyze.mjs
   ```

   `compiled.ts` and `native.ts` read `raw.json` and `compiled.json` from the study directory, so run them after the matrix.

2. Verify the recorded study in place:

   ```sh
   node scripts/research/elastic-analyze.mjs
   ```

   This reads `results/execution/elastic-memory/capacity-local` and rewrites `summary.json`. It asserts every recorded check, including the archived source hashes. Compare the regenerated file with the one in this directory.

3. Export the manifest (run from the repository root):

   ```sh
   node scripts/research/export.ts --manifest results/execution/elastic-memory/capacity-local --recursive
   ```

## Redaction and originals

The promoted `raw.json`, `full-scan.json` and `compiled.json` have their `directory` field replaced by a placeholder. The original scratch bytes, which are not in the repository, had these SHA-256 values:

| File                | Original bytes | Original SHA-256                                                 |
| ------------------- | -------------: | ---------------------------------------------------------------- |
| `raw.json`          |        247,007 | 705c53ed9ea4049fc3cf1ce4ebd21b3962fa393069aecfc4f00f3d0d1575c4ca |
| `full-scan.json`    |        520,616 | e7531d5a579693ebe81c964f5e2b5bf2d9427d312c3e234d9dae507e69bdab25 |
| `compiled.json`     |          9,193 | 9584b31cb269582b786374de6bb2572a82a567e8a27cae48a501f83ef26f5f80 |

Because the directory is a placeholder, `elastic-verify-backing.mjs` and `compiled.ts` need a fresh run's output to read the backing file. They cannot run from the promoted copies.

## Unpromoted files

- `read-only.json`: the first pilot, outside the 21-case count. Its source epoch was not archived.
- The temporary backing files are not in the repository. They were on the local machine and are not retained.
