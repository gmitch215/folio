# Folds

Chunked folds of a native kernel over a task pool, with the probes that establish the fold is
valid. Node only: the pool runs on `worker_threads` through `node/tasks.ts`, and the certificates
hash with `node:crypto`.

- `affine.ts`: probes a function `(state, pointer, length) -> state` for an affine transition over
  GF(2)^bits or Z/2^bits, and folds a buffer through it in parallel. Exported from the root entry.
- `affine-state.ts`: the same probes for kernels whose state lives in a context struct. Not
  exported from the root entry. `boundaries.ts` and the research scripts use it.
- `boundaries.ts`: records the state at each chunk boundary and verifies the recording against a
  fresh run. Not exported from the root entry; used by the affine research scripts.
- `certify.ts`: symbolic stream certificates for a wasm kernel and their verifier. Exported from
  the root entry.
- `certified.ts`: folds that run under a certificate and reconstruct the result from it. Exported
  from the root entry.
