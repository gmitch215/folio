# routing

Chooses the route for each call: serial, a window of the shared memory, an explicit records split, a tracked
region, or an iteration dispatch. `Router` runs the chosen route and records why it chose it. `decide` returns
the same choice without running anything, and `analyzeModule` reads a module's shape from its bytes.

Runs on Node. `index.ts` uses `worker_threads` and `node:crypto`, and `worker.ts` is the router worker that
`Router` starts.

Exported from the root entry (`@gmitch215/folio`): `Router`, `openRouter`, `decide`, `analyzeModule`,
`effectiveOwnership`, `CertificateCache` and the route types.
