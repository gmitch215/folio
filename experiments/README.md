# Experiments

Executable probes for runtime capabilities, native sharing, managed execution and boot images.
Sanitized records live under [results](../results/README.md). Each harness keeps its METHOD.md;
raw deployment logs and resource snapshots stay in ignored `runs/` for cleanup and recovery.

| Harness                            | Question                                                               | Environment                   |
| ---------------------------------- | ---------------------------------------------------------------------- | ----------------------------- |
| [Cloud](cloud/README.md)           | Which runtime capabilities and host transports are available?          | workerd and deployed isolates |
| [Managed](managed/README.md)       | What do copied snapshots and ordered validation cost?                  | Durable Objects               |
| [Browser](browser/README.md)       | Can agents share an arena and extract counted loops without JSPI?      | Chromium and Browser Run      |
| [Consumer](consumer/README.md)     | How do unchanged applications route and compare with native execution? | Chromium, isolates and Node   |
| [Boot Images](bootimage/README.md) | How do captured images behave during delivery, startup and replay?     | workerd and Durable Objects   |
| [Shared Tools](lib/README.md)      | Account access, metering, bundling and lifecycle helpers               | Node 26                       |

## Local Runs

```sh
bun run build:c
node experiments/cloud/local.ts
node experiments/cloud/host-probe.ts
node experiments/managed/prepare.ts
node experiments/managed/local.ts
node experiments/browser/extraction/prepare.ts
node experiments/browser/extraction/local.ts
```

Node 26 runs the drivers. Workers are TypeScript bundled by Wrangler, and each Worker
project has its own tsconfig. Browser assets are compiled before serving them to Chromium.

## Deployments

`node experiments/deploy.ts KIND` runs the selected bounded probe. It reads
`FOLIO_CLOUDFLARE_ACCOUNT_ID` and `FOLIO_CLOUDFLARE_API_TOKEN`, with the
`FREE_CLOUDFLARE_*` CI pair as fallback. It snapshots Workers, Durable Object namespaces,
KV, R2 and D1 before provisioning and verifies the baseline after retirement and deletion.
`node experiments/cleanup.ts NAME KIND` resumes cleanup after an interrupted driver.

Read the harness METHOD.md for request, storage and session bounds before a live run.
Browser Run has a daily session allowance. Durable Object rows are shared across all activity
in the account, and usage meters may lag. A fresh resource name does not reset account quotas.

## Evidence

Publish sanitized records under `results/<topic>/<study>/`, with short role names and a README.
Keep timestamps, source hashes, configuration, sample counts and environment in metadata.
Label local and deployed results separately. Preserve raw bytes and include failures and resets.
Source archives retain the measured implementation.
