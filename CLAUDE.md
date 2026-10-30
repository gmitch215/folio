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
  `iteration.ts`, `iteration-admission.ts` and `inline.ts` run a loop of independent calls on workers
  (private stack slots, inline marks, ordered validation, measured admission),
  `remote.ts` and `host.ts` are the portable client and the execution host, `managed.ts` and
  `frames.ts` are the Workers and Durable Object backend, `tasks.ts` is the Node task pool for
  work a program names itself (private contexts, copied values, optional differential audit), and
  `bake.ts` captures a booted memory, bakes it into a module and checks it (`./bake` subpath).
- `tests/c/` freestanding C fixtures, `tests/unit/` the gate, `tests/integration/` local workerd,
  `tests/e2e/` live deploys. See `tests/README.md`.
- `scripts/` build, analysis, probes and the timing rig. The folder decides the runtime. See
  `scripts/README.md`.
- `experiments/` the Cloudflare probes (`cloud`, `managed`, `browser`). See `experiments/README.md`.
- `results/` raw samples, source snapshots and summaries. Never edit a summary by hand.

## Commands

```sh
bun run build:c          # compile tests/c/*.c to build/*.wasm
bun run typecheck        # root plus the three worker projects
bun run test             # unit gate
bun run test:integration # local workerd, about 25 s
bun run test:coverage
bun run build    # dist/
bun run test:e2e # live deploy, needs FREE_CLOUDFLARE_ACCOUNT_ID and FREE_CLOUDFLARE_API_TOKEN
bun run prettier
```

## Rules

- Node 26 or later for tests. Node 24 has no usable JSPI for the managed paths.
- `src/managed.ts`, `src/frames.ts`, `src/remote.ts` and `src/values.ts` stay portable: no Node
  imports and no runtime Wasm compilation in the client.
- Fixture bytes must not depend on `PATH`. `scripts/build/fixtures.ts` removes `node_modules/.bin`
  before it calls clang, because binaryen's `wasm-opt` there changes the output.
- A claim about speed needs a paired measurement with raw samples under `results/` and the
  instrument named. Managed rows report module UUIDs, which are not isolate identities.
- Never record the Cloudflare account ID, a token or a workers.dev subdomain in a tracked file.
  Raw deploy records under `experiments/*/runs/` stay ignored.
- Live deploys snapshot the account first and must leave it equal to the baseline.
- Style: tabs, 100 columns, single quotes, no trailing commas. Comments are short and lowercase.
