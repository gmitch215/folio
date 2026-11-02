# Concurrent Lane Calls

Whether four lane calls issued at once overlap on the platform, across service-bound Workers, one
Worker, Durable Objects with and without location hints, and independent top-level requests. See
[METHOD.md](METHOD.md) for the question, the predictions and the decision rule.

```sh
node experiments/concurrency/prepare.ts            # build the kernel
node experiments/concurrency/local.ts [rounds]     # the arms on local workerd, harness check only
node experiments/concurrency/run.ts --dry-run      # the plan, counts and price, no Cloudflare call
node experiments/concurrency/run.ts                # live, paid account
node experiments/concurrency/run.ts --analyze NAME # re-summarize a saved run
```

`lane.ts` is the lane Worker, `coordinator.ts` the coordinator and the Durable Object class,
`spin.ts` the shared kernel call, `plan.ts` the schedule, arithmetic, price and decision rule.
`tests/integration/concurrency.test.ts` runs the arms on local workerd.
