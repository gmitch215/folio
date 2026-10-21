# `experiments/`

Probes that run Folio, or test its limits, on Cloudflare. Each directory holds a Worker, its
Wrangler config, a method document, the analysis code and the sanitized results.

| directory   | question                                                                                                        | runs on                                                   |
| ----------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `cloud/`    | What can a managed Worker share across isolates? Does the portable client reach a Node host from stock workerd? | deployed Workers and Durable Objects, local workerd       |
| `managed/`  | Does `ManagedFolio` extract and run regions across Durable Object lanes with exact results?                     | deployed Durable Objects, local workerd                   |
| `browser/`  | Physical sharing and automatic counted-loop extraction without JSPI over 256 MiB                                | deployed Chromium through Browser Run and a local control |
| `consumer/` | Does the paired native and Folio harness run on a FREE deployment, and what do the limits do to PHP?            | Browser Run for the harness, a Durable Object for PHP     |

## Language Boundaries

| file kind                                                                                     | language                                          | runtime                      |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------- |
| `worker.ts`                                                                                   | TypeScript                                        | workerd, bundled by Wrangler |
| `probe.ts` (browser)                                                                          | TypeScript, served to Chromium as transpiled text | Chromium                     |
| `deploy.ts`, `cleanup.ts`, `run.ts`, `local.ts`, `analyze*.ts`, `prepare.ts`, `host-probe.ts` | TypeScript                                        | Node 26 (`node file.ts`)     |
| `wrangler.jsonc`                                                                              | JSONC                                             | Wrangler                     |

Types are erasable only, so `node file.ts` runs them without a build step. Each Worker has its own
`tsconfig.json`. The shared Cloudflare driver code is in `lib/`.

## Run

```sh
bun run build:c
node experiments/cloud/host-probe.ts # stock workerd to the Node execution host
node experiments/cloud/local.ts      # capability probe in local workerd
node experiments/managed/prepare.ts
node experiments/managed/local.ts        # managed lanes in local workerd, 39 rows
node experiments/deploy.ts managed       # live deploy, needs FREE_* credentials
node experiments/cleanup.ts NAME managed # recover a run whose driver died
node experiments/browser/extraction/prepare.ts
FOLIO_BROWSER_EXTRACTION=1 node experiments/deploy.ts browser # bounded automatic extraction proof
node experiments/consumer/prepare.ts                          # page, lane, kernel, gmux ABI and tinyimg assets
node experiments/consumer/local.ts tinyimg 5 OUT.json         # the same page in a local Chromium
node experiments/deploy.ts consumer                           # paired harness on Browser Run, 3 sessions
node experiments/consumer/php/prepare.ts                      # stage the PHP artifacts from FOLIO_CONSUMER
node experiments/deploy.ts php                                # original PHP module in a Durable Object
node experiments/deploy.ts prepared                           # the four-module prepared set
```

`deploy.ts cloud|managed|browser|consumer|php|prepared` reads `FREE_CLOUDFLARE_ACCOUNT_ID` and
`FREE_CLOUDFLARE_API_TOKEN`, with `STUDENT_*` as a fallback. It snapshots the account's Workers and
Durable Object namespaces, KV, R2 and D1, deploys under a temporary `cfw-folio-*` name, runs a bounded measurement,
retires the Durable Object classes, deletes the Worker and fails unless the account matches its
baseline. Raw output goes to `NAME/runs/` and stays out of git. `FOLIO_WRANGLER` overrides the
Wrangler entry.

`consumer` runs three browser sessions at most 75 s each and refuses to start one if the Worker's
`history()` plus the session would pass the 10 browser minutes a day that Free allows. `deploy.ts`
prints the GraphQL usage meter (Worker and Durable Object requests, duration, rows) at the start, after
every step and at the end; the meter lags by minutes, so a bound is computed from the plan first.
`FOLIO_CONSUMER_RUNS` and `FOLIO_CONSUMER_PAIRS` choose the consumers and the pairs, and
`FOLIO_PLAYWRIGHT_PACKAGE` names a `package.json` beside a `node_modules/playwright-core` for the local
run. The `consumer/php/` Worker reads its artifacts from `build/php/`, staged from the drupflare
checkout, so `typecheck:php` needs those checkouts and is not part of the CI gate.

## Results

`results-*.json` files are the sanitized summaries that `TECHNICAL_REPORT.md` cites. A local result
carries a local label and is not Cloudflare evidence. Re-running a probe adds a file and never
overwrites one.

| file                                              | records                                                                     | where it ran              |
| ------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------- |
| `cloud/results-local.json`                        | capability probe: raw rows and summary                                      | local workerd             |
| `cloud/results-managed.json`                      | managed lane run, 8 rows, baseline restored                                 | deployed                  |
| `cloud/results-host-local.json`, `-local-v2.json` | stock workerd to the Node execution host, first runs                        | local workerd             |
| `cloud/results-host-final.json`, `-20261020.json` | the same probe on Miniflare 5.20260815.0-alpha                              | local workerd             |
| `cloud/results-host-consolidated.json`            | the same probe on Miniflare 5.20261019.0-beta                               | local workerd             |
| `managed/results-local.json`                      | an earlier managed lane attempt, 30 rows, stopped on an unexpected fallback | local workerd             |
| `managed/results-local-final.json`                | managed lanes, 39 rows, passed                                              | local workerd             |
| `managed/results-local-consolidated.json`         | the same 39 rows with preparation counted in wall time                      | local workerd             |
| `browser/results-local.json`                      | physical sharing, aliasing, copy control and growth                         | local Chromium            |
| `browser/results-free-extraction-20261020.json`   | automatic counted-loop extraction without JSPI, baseline restored           | FREE account, Browser Run |
| `consumer/results-free-consumer-20261020.json`    | paired native and Folio harness, three sessions                             | FREE account, Browser Run |
| `consumer/results-free-php-20261020.json`         | original PHP module in a Worker and a Durable Object                        | FREE account              |
| `consumer/results-free-prepared-*-20261020.json`  | the four-module prepared set, combined and as parts                         | FREE account              |
