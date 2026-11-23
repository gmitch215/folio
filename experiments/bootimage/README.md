# Boot Images

This harness measures module delivery, instantiation, host boot and replay eligibility.
The [method](METHOD.md) defines its arms, prerequisites, bounds and interpretation.

## Running

Run from the repository root with Node 26 and the toolchain in [scripts](../../scripts/README.md).

```sh
node experiments/bootimage/prepare.ts
node experiments/bootimage/local.ts original
```

Consumer-dependent probes require the corresponding `FOLIO_*` paths; preparation validates
the pinned artifact digests. See METHOD.md before provisioning a deployed run.

## Output

Sanitized records are indexed under [results](../../results/boot/README.md). Raw deployed runs remain in ignored
`runs/` beside this harness so interrupted resources can be retired. A new measurement creates
a new named record and preserves its source hash, environment and parameters.

## Limits

- The deployed arms use one Durable Object class on one Free account, with 4 to 10 requests per group.
- `cpuTime` is whole milliseconds from the tail.
- A reply cannot show whether the platform reuses an isolate for different object names. A changed
  `moduleTag` or an outcome other than `ok` marks a reset.
- A refused deploy is the result and is not retried.
