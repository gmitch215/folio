# Consumer boot research

This study uses the consumer's PHP 8.5.12 interpreter, filesystem, database bridge,
Drupal boot/render code and renewal PHP. It compares initialized heaps with fresh
boots. It also measures current image delivery on a Free deployment. The deployed
delivery instrument instantiates Wasm with stub imports; the local instrument runs
actual Drupal. Their measurements answer different questions.

See [METHOD.md](METHOD.md) for controls, replay requirements and limits. Results:
[configurations](../../../results/boot/configurations/README.md),
[lifecycle](../../../results/boot/lifecycle/README.md) and
[delivery](../../../results/boot/lifecycle/delivery/README.md).

## Run locally

Use Node 26, installed repository dependencies and the consumer inputs described in
[scripts](../../../scripts/README.md). Set `FOLIO_CONSUMER` to the external consumer
checkout and `FOLIO_HOST_MODULES` to its role-to-source JSON mapping. The mapping
must resolve `codec`, `fs`, `mask`, `site-store` and `worker-shim`; see
[consumer-root.ts](../../../scripts/probe/consumer-root.ts).

```sh
runtime="$PWD/build/research/boot-new"
node experiments/bootimage/research/build.ts "$runtime"
FOLIO_BOOTIMAGE_ROOT="$runtime" FOLIO_BOOTIMAGE_CHILD=1 \
  node --expose-gc "$runtime/run.mjs" prepare "$runtime/prepare.jsonl"
node experiments/bootimage/research/drive.ts \
  build/research/configurations-new "$runtime" configurations 1
node experiments/bootimage/research/analyze.ts \
  build/research/configurations-new build/research/configurations-new/analysis.json
node experiments/bootimage/research/drive.ts \
  build/research/lifecycle-new "$runtime" lifecycle 15
node experiments/bootimage/research/analyze.ts \
  build/research/lifecycle-new build/research/lifecycle-new/analysis.json
```

Each output directory must be new. `prepare` captures a new image and prepares
configuration databases. `configure` can prepare missing cases without recapturing
the image; `FOLIO_BOOT_RESEARCH_CASES=alias,content` restricts that work. Each sample
clones its case's database and runs in a new process. The external seed is read only.

`build.ts` records interpreter, glue, renewal, helper and executed-bundle hashes.
Its checked adaptations expose the existing probe helpers, choose a fresh SQLite
file and add a post-instantiation memory-copy hook. Review them when the helpers
change. A changed source tree outside this bundle does not change its executed code.

## Run deployed delivery

```sh
node experiments/bootimage/research/deploy.ts "$runtime" delivery
node experiments/bootimage/research/stored.ts experiments/bootimage/runs/RUN
```

The first command uses **only `FREE_CLOUDFLARE_*`**, deploys original, embedded-image
and asset-copy variants sequentially, and retires only its own Worker and class
after each. `FOLIO_IMAGE_MODES=baked` selects a diagnostic arm. The second command
recovers delayed stored execution meters after the run; `baked` as its second
argument restricts the query. Keep its ignored run directory until all evidence
and cleanup checks have been reviewed. Do not publish its credentials, generated
configuration, account inventories or raw provider records.

`publish.ts` reproduces this study's sanitized exports from the named ignored run
roles. It verifies existing derived JSON instead of replacing completed evidence.
Use new paths and a new study role for a future measurement.
