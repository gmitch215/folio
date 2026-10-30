# Ordinary Worker Lanes

This harness asks whether ordinary Workers joined by service bindings can run CPU work in parallel, and
whether sending only a region's bytes avoids the copy cost of a full snapshot. The
[method](METHOD.md) defines the overlap and transfer measurements, the decision rules and the bounds.

## Reproduction

Run from the repository root with Node 26 and a Free account in `FREE_CLOUDFLARE_*` (the driver
refuses any other account).

```sh
node experiments/rpc/prepare.ts
node experiments/rpc/run.ts
FOLIO_RPC_MODE=transfer node experiments/rpc/run.ts
```

Each run deploys five scripts, measures, deletes them and compares the account to its baseline. A run
that dies before cleanup leaves scripts named `cfw-folio-rpc-*`; delete them in the dashboard.

## Evidence

The sanitized record is [ordinary-worker-lanes](../../results/managed/ordinary-worker-lanes/README.md).
Raw run records stay in ignored `runs/`.
