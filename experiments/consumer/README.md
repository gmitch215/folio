# Consumer Execution

This harness measures native comparisons and observed extraction on real consumer artifacts.
The [method](METHOD.md) defines its arms, prerequisites, bounds and interpretation.

## Reproduction

Run from the repository root with Node 26 and the toolchain in [scripts](../../scripts/README.md).

```sh
node experiments/consumer/prepare.ts kernel-control
node experiments/consumer/local.ts kernel-control 5 OUT.json
```

Consumer-dependent probes require the corresponding `FOLIO_*` paths; preparation validates
the pinned artifact digests. See METHOD.md before provisioning a deployed run.

## Evidence

Sanitized records are indexed under [results](../../results/browser/consumers/README.md). Raw deployed runs remain in ignored
`runs/` beside this harness so interrupted resources can be retired. A new measurement creates
a new named record and preserves its source hash, environment and parameters.
