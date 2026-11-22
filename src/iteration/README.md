# iteration

Runs the iterations of a loop of calls on worker threads, with ordered validation. Node only: the
workers use `node:worker_threads`. Reached from `Folio` (the `.` entry) through `src/node/index.ts`;
`src/routing/index.ts` reads the admission constants.

- `index.ts`: `IterationPool`, which dispatches batches, validates them in order, rolls back and
  replays failed iterations, and decides whether the loop keeps dispatching. Also holds the
  conflict checks.
- `inline.ts`: lowers the loop body so each load and store is tracked, and builds the iteration
  module that workers run.
- `owner.ts`: builds the owner module, which runs the loop through the pool and keeps the serial
  fallback.
- `admission.ts`: the decisions that gate dispatch and their fitted constants.
- `worker.ts`: the worker entry. `index.ts` starts it by URL, so it is built next to the module.
