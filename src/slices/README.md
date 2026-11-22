# Slices

A pool of Node worker threads that each run calls of one WebAssembly module over a disjoint range of records. Runs on Node only. The root entry (`src/index.ts`) re-exports everything here.

- `index.ts`: `SlicePool`, its options and reports, the `$bigint`-aware JSON codec (`encodeValues`, `decodeValues`), and `sharedMemoryImport`.
- `worker.ts`: the worker entry. `SlicePool` loads it by URL relative to `import.meta.url`, so the two files must stay in this folder side by side.
