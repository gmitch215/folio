# Ownership

Certifies that a WebAssembly module writes only inside the windows it declares, so that each record can run on its own private copy of those windows. Runs on Node: the analysis reads modules through Binaryen and hashes them with `node:crypto`. The root entry (`src/index.ts`) re-exports everything here.

- `index.ts`: the certificate analysis. `certifyOwnership` produces an `OwnershipCertificate`, `verifyOwnership` re-derives it, and `guardRecords` and `checkConfig` check the record regions and config words at run time.
- `redirect.ts`: `redirectOwnership` rewrites a certified module so each window access adds a per-worker delta, and `ownershipRoute` returns that redirect with the iteration route it implies.
- `slices.ts`: `OwnershipSlices` runs a redirected module through a `SlicePool`, restores the record writes after a trap, and replays the calls serially.
