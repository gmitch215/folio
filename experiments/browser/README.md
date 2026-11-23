# Browser Execution

This harness measures shared backing, atomics, growth and automatic counted-loop extraction.
The [method](METHOD.md) defines its arms, prerequisites, bounds and interpretation.

## Running

Run from the repository root with Node 26 and the toolchain in [scripts](../../scripts/README.md).

```sh
node experiments/browser/prepare.ts
node experiments/browser/extraction/prepare.ts
node experiments/browser/extraction/local.ts
```

Consumer-dependent probes require the corresponding `FOLIO_*` paths; preparation validates
the pinned artifact digests. See METHOD.md before provisioning a deployed run.

## Output

Sanitized records are indexed under [results](../../results/browser/README.md). Raw deployed runs remain in ignored
`runs/` beside this harness so interrupted resources can be retired. A new measurement creates
a new named record and preserves its source hash, environment and parameters.
`extraction/analyze.ts` writes the credential-free record of one retained extraction run.

## Limits

- A deployed run needs `PROBE_TOKEN` as a deployed secret. One session runs at a time, and a run makes at
  most two attempts, including failed launches.
- The session deadline is 85 s. The Free plan allows 10 browser minutes a day, three concurrent browsers
  and one new browser every 20 s.
- Without JSPI in the managed browser, only counted-loop extraction runs.
