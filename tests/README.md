# `tests/`

| where                | what                                                                                                     | runs                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `tests/c/`           | freestanding C fixtures: `fixture.c`, `sharing.c`, `generalized.c`, `records.c`                          | compiled to `build/*.wasm` by `bun run build:c` |
| `tests/unit/`        | the gate, in folders that mirror `src/`; `scripts/` and `experiments/` tests sit under their own folders | `bun run test`, about 40 seconds in all         |
| `tests/helpers/`     | worker entry points the task tests and `scripts/probe/tasks-runtime.ts` spawn: the task pool             | spawned by `tests/unit/node/` and `scripts/`    |
| `tests/integration/` | local stock workerd through Miniflare: host probe, capability probe, managed lanes                       | `bun run test:integration`, about 25 seconds    |
| `tests/e2e/`         | live deploys to a Cloudflare account                                                                     | `bun run test:e2e`, skipped without credentials |

`tests/setup.ts` rebuilds the C fixtures when a source file is newer than its output, so a fresh
checkout runs the gate after installing `clang` and `lld`.

## Fixtures

Each C file is a separate artifact and a separate claim. `fixture.c` builds with inlining off and
holds the counted-loop kernels. `generalized.c` builds with ordinary inlining and holds the branchy
entry with a scalar carried across iterations. `sharing.c` holds the atomic and aliasing controls.
`records.c` holds one loop that calls a function per record, the shape the iteration route runs on
workers, and backs `examples/iteration.ts`.
Fixture bytes must not depend on the machine's `PATH`; `tests/unit/scripts/build/fixtures.test.ts` checks that.

## Conventions

- `tests/unit/` and `tests/integration/` mirror `src/`: `src/<folder>/<file>.ts` is tested by
  `<folder>/<file>.test.ts`, and a folder's `index.ts` by `index.test.ts`.
- One spec file per domain. Extend `tests/unit/managed/index.test.ts` rather than adding a second
  managed spec.
- The gate is hermetic. Nothing in `unit/` opens a network connection or a real Cloudflare binding.
- Each unit spec file is meant to run in under 2 seconds on an idle machine. Under load some files take
  longer.
- Probe workers run in `experiments/`, and their logic is tested here by importing the exports with
  the platform modules mocked (`tests/unit/experiments/browser/probe.test.ts`).
- A bug fix lands with the regression test that would have caught it.

## Live Deploys

`tests/e2e/live-deploy.test.ts` runs `experiments/deploy.ts` for the capability probe and the
managed lanes. Each run snapshots the account's Workers and Durable Object namespaces first and
fails if they differ afterwards. Set `FOLIO_E2E_BROWSER=1` to include Browser Run, which has a daily
minute allowance on Free.

The Free plan allows 100,000 Durable Object rows written per UTC day across the account. Before the
first deploy the suite reads the account's rows written today and skips with a notice that names the
reset time when a run would not fit; a deploy that the platform refuses for the same reason skips
too, instead of failing. The meter can under-read on Free, so the refusal text is the second check.

## Continuation

`tests/unit/memory/continuation.test.ts` covers `src/memory/continuation.ts` on a fake storage and a memory
seam, with no Durable Object. The continuation experiments are not tests; they are described in
[experiments/continuation](../experiments/continuation/README.md).
