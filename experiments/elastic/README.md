# Elastic Memory Probe

Live scripts for the managed envelope study. The question, the result and the procedure are in [managed-envelope](../../results/execution/elastic-memory/managed-envelope/README.md) and its [METHOD](../../results/execution/elastic-memory/managed-envelope/METHOD.md).

- `run.ts` deploys the fixture worker to the Free account and runs the continuation chain. It writes to `FOLIO_MANAGED_OUTPUT` (default `./runs/`, which is git-ignored).
- `worker.mjs` is the deployed Worker: an executor Durable Object and four page-owner Durable Objects.
- `tail.ts`, `metrics.ts`, `metrics-do.ts`, `introspection.ts`, `check-cleanup.ts` and `freeze.ts` read or record telemetry for a run directory named by `FOLIO_ELASTIC_RUN`.

Nothing here runs by default. A live run spends on the account and needs the Free credential pair.
