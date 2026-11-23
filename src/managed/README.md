# Managed

The Workers and Durable Object backend. `index.ts` holds `ManagedFolio`, which runs the original Wasm
stack at an owner and sends compiler-discovered regions to named lanes, and `FolioLane`, the lane side
that runs a region against a frozen snapshot and returns its read and write sets. `ManagedArtifact`,
`ManagedLaneTransport` and `ManagedReport` describe the inputs, the transport and the result.

Lane frames use `../remote/frames.ts`, and region coordination uses `../execution/coordinator.ts`.

Portable: no Node imports. It instantiates precompiled modules and compiles no Wasm. Exported through
`src/workers.ts` as the `./workers` subpath.
