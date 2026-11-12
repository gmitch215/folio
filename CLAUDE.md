# folio - repo guide

Native WebAssembly across several V8 isolates over one physical memory allocation, with a compiler
that discovers independent regions and an ordered validator that keeps the serial result. Bun for
tooling, Node 26 for anything that needs `worker_threads` or JSPI, strict ESM TypeScript with
erasable syntax only.

`TECHNICAL_REPORT.md` is the evidence and the limits. Read its "Limits and Open Questions" before
claiming anything about speed, isolates, accounts or consumers.

## Layout

- `src/` the library. `compiler.ts` and `extract.ts` find regions, `guards.ts` proves native
  kernels, `transaction.ts` and `coordinator.ts` run and validate them, `node.ts` is the Node pool,
  `iteration*.ts` and `inline.ts` run the iterations of a loop of calls on workers (private stack
  slots, inline marks, ordered validation, measured admission), `ownership*.ts` is the ownership
  certificate with its stack-redirect and slice routes, `router.ts` and `router-worker.ts` choose a
  route per call, `slices.ts` is the slice pool for records the caller declares independent,
  `affine*.ts`, `fold.ts`, `certify.ts` and `certified.ts` are the chunked recurrences and the
  certified stream folds, `ranges.ts`, `runs.ts`, `read-*.ts` and `memo.ts` track footprints,
  `remote.ts` and `host.ts` are the portable client and the execution host, `managed.ts`,
  `frames.ts`, `pages.ts` and `lease.ts` are the Workers and Durable Object backend and its page
  owner, `tasks.ts` is the Node task pool for work a program names itself (private contexts,
  copied values, optional differential audit), and `bake.ts` captures a booted memory, bakes it
  into a module and checks it (`./bake` subpath).
- `tests/c/` freestanding C fixtures, `tests/unit/` the gate, `tests/integration/` local workerd,
  `tests/e2e/` live deploys. See `tests/README.md`.
- `scripts/` build, analysis, probes and the timing rig. The folder decides the runtime. See
  `scripts/README.md`.
- `experiments/` the Cloudflare and browser probes (`cloud`, `managed`, `elastic`, `elastic-limits`,
  `elastic-ladder`, `browser`, `consumer`, `bootimage`, `rpc`, `ranges`, `concurrency`,
  `sqlite-lanes`, `corpus-lanes`). See `experiments/README.md`.
- `results/` raw samples, source snapshots and summaries, one directory per study
  (`results/<topic>/<study>/` with a README, `raw/` and a manifest). Never edit a summary by hand.
  `scripts/research/evidence.ts` verifies every manifest.

## Commands

```sh
bun run build:c          # compile tests/c/*.c to build/*.wasm
bun run typecheck        # root plus eleven experiment projects
bun run test             # unit gate
bun run test:integration # local workerd, about 25 s
bun run test:coverage
bun run build    # dist/
bun run test:e2e # live deploy, needs FREE_CLOUDFLARE_ACCOUNT_ID and FREE_CLOUDFLARE_API_TOKEN
bun run prettier
bun run prettier:check
```

`bun run typecheck:php` and `bun run typecheck:bootimage` check those two experiment projects on
their own. `build:c` needs `clang` and `wasm-ld` (the `lld` package) on `PATH`.

## Rules

- Node 26 or later for tests. Node 24 has no usable JSPI for the managed paths.
- Run vitest through the package scripts or pass `--project`. A bare `vitest run` includes the
  `e2e` project, which deploys when the Cloudflare credentials are in the environment.
- `src/managed.ts`, `src/frames.ts`, `src/remote.ts` and `src/values.ts` stay portable: no Node
  imports and no runtime Wasm compilation in the client.
- Fixture bytes must not depend on `PATH`. `scripts/build/fixtures.ts` removes `node_modules/.bin`
  before it calls clang, because binaryen's `wasm-opt` there changes the output.
- A claim about speed needs a paired measurement with raw samples under `results/` and the
  instrument named. Managed rows report module UUIDs, which are not isolate identities.
- The 47-driver final corpus was spent on the v1.1 evaluation (`results/execution/final-evaluation`).
  It is a development set now: do not tune the router against it and report the result as final.
- Never record the Cloudflare account ID, a token or a workers.dev subdomain in a tracked file.
  Raw deploy records under `experiments/*/runs/` stay ignored.
- Live deploys snapshot the account first and must leave it equal to the baseline.
- Style: tabs, 100 columns, single quotes, no trailing commas. Comments are short and lowercase.
