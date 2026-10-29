# Managed Phases

This probe separates observed pool reuse, copied snapshot traffic and whole-lifecycle cost on
deployed Workers and Durable Objects. The [method](METHOD.md) defines the clocks, request counts
and retained failed attempts. [Results](../../../results/managed/phases/README.md) include all five
executed studies and source digests.

Run from the repository root with Node 26, the existing fixture toolchain and Free account
credentials in `FREE_CLOUDFLARE_ACCOUNT_ID` and `FREE_CLOUDFLARE_API_TOKEN`:

```sh
bun run build:c
node experiments/managed/prepare.ts
FOLIO_PHASE_PAGES=2,128 FOLIO_PHASE_WIDTHS=2,8 node experiments/managed/phases/drive.ts
```

The driver creates one temporary Worker and two SQLite-backed DO classes, makes no application
storage calls, and retires its own resources before comparing the account baseline. Raw records
remain in ignored `experiments/managed/runs/`. The `measure` entry mode and `measure.ts` produce the [operation costs](../../../results/managed/operations/README.md). Use an unused output role when analyzing a run:

```sh
node experiments/managed/phases/analyze.ts experiments/managed/runs/RUN results/managed/phases repeat
```
