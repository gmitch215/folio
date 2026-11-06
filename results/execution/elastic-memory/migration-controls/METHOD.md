# Migration Controls: Method

Run from the repository root. Node 26 is required for the TypeScript entry points.

## Predictions

`predictions.json` holds the control predictions, written before the touched-receiver run. `sweep-predictions.json` holds the model counts for the frame sweep, written by the predict mode before the executor run. Neither file is edited after its run.

```sh
node scripts/probe/elastic/sweep.ts predict
```

## Touched-Receiver Matrix

The matrix runs 15 cases: five controls at receiver touch counts 1, 2 and 4. The output is written to `touched-raw.json` with the directory field replaced by a placeholder.

```sh
FOLIO_ELASTIC_MATRIX=touched FOLIO_ELASTIC_OUTPUT=results/execution/elastic-memory/migration-controls/touched-raw.json node scripts/probe/elastic/run.ts
```

The default matrix in `run.ts` (no `FOLIO_ELASTIC_MATRIX`) is the capacity-local matrix. Its archived source is in [capacity-local/source-final](../capacity-local/source-final/), so rerunning the default matrix with the current code reproduces the same payloads but writes `directory` as the placeholder `<scratch>`.

The run builds a 2 GiB deterministic backing file in the system temporary directory. That file is not retained.

## Frame Sweep

```sh
node scripts/probe/elastic/sweep.ts run
```

The run builds a 192 MiB backing file of 3,072 pages in the system temporary directory and runs 42 cases: three traces, seven frame counts and two policies. It writes `sweep-raw.json` and `sweep-summary.json`. Both writes refuse to overwrite. A rerun needs a fresh study directory through `FOLIO_SWEEP_STUDY`.

The model comparison in the summary checks LRU fetches, writebacks and fault counts against `sweep-predictions.json`.

## Analysis

```sh
node scripts/research/elastic-controls.mjs
```

The analyzer checks the archived sources against the hashes in `touched-raw.json`, asserts every row is exact, compares each touched row with its prediction, and compares the four t = 4 rows with [capacity-local/raw.json](../capacity-local/raw.json). It writes `summary.json`. A prediction mismatch is recorded in `predictionMismatches` and does not stop the analyzer.

## Sources

`source/` holds the sources the recorded runs used: `run.ts`, `worker.ts`, `access.ts`, `sweep.ts` and `elastic-model.ts`. The hashes in the raw files match these copies.

## Manifest

```sh
node scripts/research/export.ts --manifest results/execution/elastic-memory/migration-controls --recursive
```
