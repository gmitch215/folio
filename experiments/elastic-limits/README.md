# Elastic Limits Probe

Live scripts for the platform ladder and the spill-memory arms. The questions, results and procedures are in [platform-ladder](../../results/execution/platform-ladder/README.md) and [spill-memory](../../results/execution/spill-memory/README.md), each with a METHOD.

- `live.ts` prices the selected rungs and prints the price table. With `--approved` it deploys a throwaway Worker per script group (`ladder`, `spill`, `mem`) to the Free account, runs the rungs, reads the platform meter, retires the Worker and checks the account against its baseline. `--cleanup NAME --group GROUP --baseline SHA256` recovers a group whose driver died.
- `config.ts` holds the live and tiny presets, the class lists and the abort caps. `plan.ts` prices rows, requests and internal calls from the config, and `counters.ts` counts them during the run.
- `runner.ts` runs the rungs and writes one raw line per call. `worker-ladder.mjs` and `worker-mem.mjs` are the deployed Workers.
- `meter.ts` reads the account GraphQL meter. `recover-meter.ts` reads namespaces a run did not list.
- `redact.ts` removes workers.dev hosts and remembered account values from every line and file. `harness.ts` builds the run context.
- `analyze.ts` prints the tables of a run directory. `local.ts` starts one group on local workerd.

```sh
node experiments/elastic-limits/live.ts --rungs 6d
FREE_CLOUDFLARE_ACCOUNT_ID=... FREE_CLOUDFLARE_API_TOKEN=... node experiments/elastic-limits/live.ts --rungs 6d --row-cap 30000 --approved
node experiments/elastic-limits/analyze.ts results/execution/spill-memory/size-ladder
```

Without `--approved` the command is a dry run with no network. A live run writes to `runs/` here, which is git-ignored, and spends rows on the account. Rungs 6b to 6e are outside the default list and need a raised `--row-cap`.
