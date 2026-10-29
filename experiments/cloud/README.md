# Runtime Capabilities

This harness measures capabilities and the portable execution host.
The [method](METHOD.md) defines its arms, prerequisites, bounds and interpretation.

## Reproduction

Run from the repository root with Node 26 and the toolchain in [scripts](../../scripts/README.md).

```sh
node experiments/cloud/local.ts
node experiments/cloud/host-probe.ts
```

Consumer-dependent probes require the corresponding `FOLIO_*` paths; preparation validates
the pinned artifact digests. See METHOD.md before provisioning a deployed run.

## Evidence

Sanitized records are indexed under [results](../../results/portability/README.md). Raw deployed runs remain in ignored
`runs/` beside this harness so interrupted resources can be retired. A new measurement creates
a new named record and preserves its source hash, environment and parameters.
