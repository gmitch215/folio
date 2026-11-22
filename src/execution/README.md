# execution

The compiler and run-time core of the parallel path. Everything here is portable: at run time the
files import `binaryen` and each other, with no Node builtins.

- `compiler.ts`: `prepare` and `prepareContext` find loop and control-flow plans in a module. Both
  are exported from the root entry.
- `extract.ts`: control-flow and iteration route extraction, and admission estimates.
- `guards.ts`: proofs that a native kernel may run on the shared allocation.
- `coordinator.ts`: runs regions on workers and validates their results in order. Used by the Node
  pool and by `./workers`.
- `transaction.ts` and `runs.ts`: speculative writes and their run encoding.
- `import-order.ts`: restores the original import section after extraction.
- `fold.ts`: chunked folds over a task pool. Exported from the root entry.
