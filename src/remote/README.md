# Remote

Transport for running a registered artifact on a host across a network boundary. `index.ts` holds
`RemoteFolio`, its error types, and the value codec that crosses the boundary. `frames.ts` is the
frame codec that managed lanes use to move memory snapshots and run results. `values.ts` keeps the
numeric bits that structured clone drops.

- `index.ts`: `RemoteFolio`, `RemoteError`, `UncertainDelivery`, `encodeValue` and `decodeValue`.
- `frames.ts`: frame encoding for lanes. Internal; `./workers` does not export it.
- `values.ts`: NaN payloads and bigint values of returned numbers. Internal.

Portable: runs on Node, Workers and browsers, with no Node imports and no runtime WebAssembly
compilation. `index.ts` is exported through `src/workers.ts` as the `./workers` subpath.
