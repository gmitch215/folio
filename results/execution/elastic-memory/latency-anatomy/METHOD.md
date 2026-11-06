# Latency Anatomy: Method

## Inputs

- `managed-envelope/requests.jsonl`: one row per HTTP attempt of the managed run. Each row has the request path, the status and the wall time.

## Split

Run from the repository root:

```sh
node scripts/research/elastic-latency-split.mjs results/execution/elastic-memory/managed-envelope/requests.jsonl results/execution/elastic-memory/latency-anatomy/summary.json
```

The script separates the 576 write-phase requests from the 385 read-phase requests and reports per-lane, per-quarter and status statistics. Its output is `summary.json`. The second argument is required, and the script refuses to overwrite a file.

## Model

```sh
node scripts/research/elastic-model.ts results/execution/elastic-memory/latency-anatomy/model.json
```

The model file is in `scripts/research/elastic-model.ts`, with its tests in `tests/unit/elastic-model.test.ts`. The second argument is required, and the script refuses to overwrite a file.

The fitted hop cost (`refit.hopMs` in `model.json`) is one parameter fitted to one run. The calibration test is therefore not an independent check.

## Manifest

```sh
node scripts/research/export.ts --manifest results/execution/elastic-memory/latency-anatomy
```
