# Managed Execution

This harness measures copied snapshots, region execution, validation and transport.
The [method](METHOD.md) defines its arms, prerequisites, bounds and interpretation.

## Running

Run from the repository root with Node 26 and the toolchain in [scripts](../../scripts/README.md).

```sh
node experiments/managed/prepare.ts
node experiments/managed/local.ts
```

Consumer-dependent probes require the corresponding `FOLIO_*` paths; preparation validates
the pinned artifact digests. See METHOD.md before provisioning a deployed run.

## Output

Sanitized records are indexed under [results](../../results/managed/README.md). Raw deployed runs remain in ignored
`runs/` beside this harness so interrupted resources can be retired. A new measurement creates
a new named record and preserves its source hash, environment and parameters.

## Limits

- The backend copies one complete canonical snapshot per lane batch and has no distributed page owners.
- The canonical memory must fit the owner, and each lane must fit its snapshot, frames and private logs.
- Copy counters count explicit snapshot bytes and wire frame bytes. The platform does not expose every
  internal serializer copy.
