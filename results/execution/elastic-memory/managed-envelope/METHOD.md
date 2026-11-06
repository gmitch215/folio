# Managed Envelope: Method

## Question and fixture

The fixture is the static Wasm module in `source/fixture.wasm`. It is a memory-lowered and Asyncify-transformed module, unchanged from the copy the run used. Its procedure is the one in the README.

## Limits and budget

Read before any live run:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): Free HTTP CPU allowance 10 ms; 128 MB per isolate including JS and Wasm; 50 subrequests per request.
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/): default DO CPU allowance 30 seconds per request.
- [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): Free includes 100,000 requests a day, 100,000 rows written and 5 million rows read. Quotas are account-wide.

`budget.json` fixes 2,000 client requests, 25,000 planned DO calls and 16,000 logical row writes including cleanup. The dense program performs 9,216 page puts, one fill and two scalar stores per page. Cleanup counts 3,072 deleted page rows. Logical counts are not billed totals. Expected direct spend is $0 on the known Free credential pair.

## Procedure

The live scripts live in `experiments/elastic/`. They need a run directory, which must be git-ignored or outside the repository (the default is `experiments/elastic/runs/`, which is ignored):

```sh
FOLIO_MANAGED_OUTPUT=/path/to/run/ node experiments/elastic/run.ts
FOLIO_ELASTIC_RUN=/path/to/run/ node experiments/elastic/tail.ts
FOLIO_ELASTIC_RUN=/path/to/run/ node experiments/elastic/metrics.ts
FOLIO_ELASTIC_RUN=/path/to/run/ node experiments/elastic/metrics-do.ts
FOLIO_ELASTIC_RUN=/path/to/run/ node experiments/elastic/introspection.ts
FOLIO_ELASTIC_RUN=/path/to/run/ node experiments/elastic/check-cleanup.ts
FOLIO_ELASTIC_RUN=/path/to/run/ node experiments/elastic/freeze.ts
```

Running `run.ts` deploys to the account. This study was not re-run for E0. Do not run it without the Free credential pair and an explicit go.

## Offline analysis

The analyzer reads only this directory, plus the unpromoted tail log. Set `FOLIO_ELASTIC_TAIL` to that file's location on the machine that holds it:

```sh
FOLIO_ELASTIC_TAIL=/path/to/tail-valid.log node scripts/research/elastic-managed-analyze.ts
```

It asserts every recorded total and writes `summary.json` only when the file is missing. With the file present it compares the regenerated summary with the one here.

## Evidence and redaction

- `raw.json` has the segment headers, the return value, the full-page verification totals and client wall time. It is unchanged from the run.
- `requests.jsonl` has one row per HTTP attempt. The run identifier in each path is replaced by `<run-id>`. Original SHA-256 of the unredacted file: `06158206e191a71a5aa461674c39d73a8016248c8bcbc4d044d375a795052621`.
- `source.json` (final run) has the run identifier replaced. Original SHA-256: `da4e9c736eccb56bf6261884c8ac92efef53bb4efb0a629c321fc6a1570e95b6`.
- `first-run/source.json` has the same replacement. Original SHA-256: `02075c511e6a312d417d77ec662a12a4b31703b1cfce5b4429dfb301d2a2c368`.
- `inventory-counts.json` has counts of the account inventories and the SHA-256 of each original. The originals name resource identifiers and are not promoted. The final run's `baseline.json` and `after.json` are identical in content (same hash).
- Not promoted: `tail-valid.log` (its 90-second tail carries workers.dev hosts). Its summary is the `tail` section of `summary.json`. The first run's `tail.log` (its failed sampling-rate attempt) carries a local home path.

## Frozen source

`source/` is the executed worker and runner, with `sources.json` holding their SHA-256 and byte counts. `experiments/elastic/worker.mjs` and `run.ts` are the current versions. The analyzer asserts that the frozen worker and fixture match the manifest. The current `run.ts` differs from the frozen one, and the frozen copy is the one that produced this record.
