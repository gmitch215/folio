# folio - repo guide

WebAssembly tooling for Node, Workers and browsers. Its core runs native WebAssembly across several
V8 isolates over one physical memory allocation, with a compiler that discovers independent regions
and an ordered validator that keeps the serial result. Around it sit the pools, the instance
checkpoints, the baked boot images and the growth governor. Bun for
tooling, Node 26 for anything that needs `worker_threads` or JSPI, strict ESM TypeScript with
erasable syntax only.

`TECHNICAL_REPORT.md` is the evidence and the limits. Read its "Limits and Open Questions" before
claiming anything about speed, isolates, accounts or consumers.

## Layout

- `src/` the library. `index.ts` at the root is the `.` entry. One folder per concern:
  - `execution/` finds regions and proves native kernels (`compiler`, `extract`, `guards`), runs
    and validates them (`transaction`, `coordinator`), and holds `fold`, `runs` and `import-order`.
  - `footprints/` read and write footprints: `ranges`, `memo`, `read-scan`, `read-windows`.
  - `iteration/` runs the iterations of a loop of calls on workers: the pool and its worker,
    admission, owner memory and inline lowering (private stack slots, measured admission).
  - `folds/` the chunked affine recurrences, the stream certifier and the certified folds.
  - `ownership/` the ownership certificate with its stack-redirect and slice routes.
  - `routing/` chooses a route per call (`index.ts`, `worker.ts`).
  - `slices/` the slice pool for records the caller declares independent.
  - `node/` the Node pool (`index.ts`, `worker.ts`), the task pool for work a program names itself
    (`tasks`), instance checkpoints (`context`) and the execution host (`host`).
  - `remote/` the portable client, frame codec and value codec (`remote`, `frames`, `values`).
  - `managed/` the Workers and Durable Object backend.
  - `memory/` elastic memory: pages and leases, the growth governor, memory imports and the
    iteration arena layout; boot images (`bake`, `./boot` subpath); continuations across Durable
    Object alarm events with page-hash checkpoints in SQLite (`continuation`, `./continuation`).
  - `browser/` the browser pool and its worker.
- `tests/c/` freestanding C fixtures, `tests/unit/` the gate, `tests/integration/` local workerd,
  `tests/e2e/` live deploys. See `tests/README.md`.
- `scripts/` build, analysis, probes and the timing rig. The folder decides the runtime. See
  `scripts/README.md`.
- `experiments/` the Cloudflare and browser probes (`cloud`, `managed`, `elastic`, `elastic-limits`,
  `elastic-ladder`, `browser`, `consumer`, `bootimage`, `rpc`, `ranges`, `concurrency`,
  `sqlite-lanes`, `corpus-lanes`, `alarm-discipline`, `alarm-retirement`, `commit-ladder`,
  `idle-floor`, `memory-ladder`, `growth-governor`, `continuation`, `continuation-php`). See `experiments/README.md`.
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
- `src/managed/index.ts`, `src/remote/frames.ts`, `src/remote/index.ts` and `src/remote/values.ts` stay portable: no Node
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
- A write left pending while a guest runs synchronously for about 30 s resets the object; commit
  before running the guest.
