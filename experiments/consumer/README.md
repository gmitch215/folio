# Consumer Execution

This harness measures native comparisons and observed extraction on real consumer artifacts.
The [method](METHOD.md) defines its arms, prerequisites, bounds and interpretation.

## Running

Run from the repository root with Node 26 and the toolchain in [scripts](../../scripts/README.md).

```sh
node experiments/consumer/prepare.ts kernel-control
node experiments/consumer/local.ts kernel-control 5 OUT.json
```

Consumer-dependent probes require the corresponding `FOLIO_*` paths; preparation validates
the pinned artifact digests. See METHOD.md before provisioning a deployed run.

## Output

Sanitized records are indexed under [results](../../results/browser/consumers/README.md). Raw deployed runs remain in ignored
`runs/` beside this harness so interrupted resources can be retired. A new measurement creates
a new named record and preserves its source hash, environment and parameters.

## Limits

- CPU is not reported, because a page has no process CPU.
- A session stops starting new cases after its time budget and reports the pairs it completed.
- Consumer modules are read from the `FOLIO_*` paths and are never edited.
