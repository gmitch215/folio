# `experiments/`

Probes that run Folio, or test its limits, on Cloudflare. Each directory holds a Worker, its
Wrangler config, a method document, the analysis code and the sanitized results.

| directory  | question                                                                                                        | runs on                                             |
| ---------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `cloud/`   | What can a managed Worker share across isolates? Does the portable client reach a Node host from stock workerd? | deployed Workers and Durable Objects, local workerd |
| `managed/` | Does `ManagedFolio` extract and run regions across Durable Object lanes with exact results?                     | deployed Durable Objects, local workerd             |
| `browser/` | Can Browser Run workers share one 256 MiB Wasm allocation and scale a kernel?                                   | deployed Chromium through Browser Run               |

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
```

`deploy.ts cloud|managed|browser` reads `FREE_CLOUDFLARE_ACCOUNT_ID` and
`FREE_CLOUDFLARE_API_TOKEN`, with `STUDENT_*` as a fallback. It snapshots the account's Workers and
Durable Object namespaces, deploys under a temporary `cfw-folio-*` name, runs a bounded measurement,
retires the Durable Object classes, deletes the Worker and fails unless the account matches its
baseline. Raw output goes to `NAME/runs/` and stays out of git. `FOLIO_WRANGLER` overrides the
Wrangler entry.

## Results

`results-*.json` files are the sanitized summaries that `TECHNICAL_REPORT.md` cites. A local result
carries a local label and is not Cloudflare evidence. Re-running a probe adds a file and never
overwrites one.
