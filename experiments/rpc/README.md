# Ordinary Worker Lanes

This harness asks whether ordinary Workers joined by service bindings can run CPU work in parallel, and
whether sending only a region's bytes avoids the copy cost of a full snapshot. The
[method](METHOD.md) defines the overlap and transfer measurements, the decision rules and the bounds.

## Running

Run from the repository root with Node 26 and a Free account in `FREE_CLOUDFLARE_*` (the driver
refuses any other account).

```sh
node experiments/rpc/prepare.ts
node experiments/rpc/run.ts
FOLIO_RPC_MODE=transfer node experiments/rpc/run.ts
```

Each run deploys five scripts, measures, deletes them and compares the account to its baseline. A run
that dies before cleanup leaves scripts named `cfw-folio-rpc-*`; delete them in the dashboard.

## Output

The sanitized record is [ordinary-worker-lanes](../../results/managed/ordinary-worker-lanes/README.md).
Raw run records stay in ignored `runs/`.

## Limits

- The driver refuses any account other than the Free account in `FREE_CLOUDFLARE_*`.
- No Folio code runs in the probe.
- The observed overlap of a 4 ms kernel does not reproduce at 100 ms of CPU per call; see
  [Concurrent Lane Calls](../concurrency/README.md).
