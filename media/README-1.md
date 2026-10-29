# `tests/`

| where                | what                                                                                                                                           | runs                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `tests/c/`           | freestanding C fixtures: `fixture.c`, `sharing.c`, `generalized.c`                                                                             | compiled to `build/*.wasm` by `bun run build:c` |
| `tests/unit/`        | the gate: compiler, coordinator, transactions, memory, boot image baking, context checkpoints, host, remote, managed, probes, research tooling | `bun run test`, under 5 seconds                 |
| `tests/helpers/`     | worker entry points the unit tests spawn: the browser bridge and the task pool                                                                 | imported by `tests/unit/`                       |
| `tests/integration/` | local stock workerd through Miniflare: host probe, capability probe, managed lanes                                                             | `bun run test:integration`, about 25 seconds    |
| `tests/e2e/`         | live deploys to a Cloudflare account                                                                                                           | `bun run test:e2e`, skipped without credentials |

`tests/setup.ts` rebuilds the C fixtures when a source file is newer than its output, so a fresh
checkout runs the gate after installing `clang` and `lld`.

## Fixtures

Each C file is a separate artifact and a separate claim. `fixture.c` builds with inlining off and
holds the counted-loop kernels. `generalized.c` builds with ordinary inlining and holds the branchy
entry with a scalar carried across iterations. `sharing.c` holds the atomic and aliasing controls.
Fixture bytes must not depend on the machine's `PATH`; `tests/unit/fixtures.test.ts` checks that.

## Conventions

- One spec file per domain. Extend `managed.test.ts` rather than adding a second managed spec.
- The gate is hermetic. Nothing in `unit/` opens a network connection or a real Cloudflare binding.
- Probe workers run in `experiments/`, and their logic is tested here by importing the exports with
  the platform modules mocked (`browser-probe.test.ts`).
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
