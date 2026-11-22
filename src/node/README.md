# node

The Node execution layer: the `Folio` worker pool, the task pool, instance checkpoints and the execution host.

- `index.ts` holds `Folio`, which compiles a program, runs its regions on a pool of `worker_threads` and
  validates the result against the serial run.
- `tasks.ts` holds `TaskPool`, which runs named functions on workers, and `serveTasks` for the worker side.
- `context.ts` holds `InstanceCheckpoint`, which captures an instance's private Wasm state after
  initialization and restores it.
- `host.ts` holds `FolioHost`, the same-process execution host behind an authenticated fetch handler.
- `worker.ts` is the pool worker entry, started by URL from `index.ts`.

Runs on Node only. Every module here imports `worker_threads` or `node:` builtins, so the Workers and browser
entries never reach it. The root entry (`@gmitch215/folio`) re-exports the public names.
