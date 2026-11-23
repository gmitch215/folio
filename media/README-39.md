# Sync Commit

Does `await ctx.storage.sync()` make a write survive a CPU kill that follows it with no other yield?

## Instrument

The `M1` Durable Object class (`experiments/alarm-retirement/m1-worker.mjs`, config `sync-wrangler.jsonc`) takes a `sync` query parameter on `/ev`. It writes the marker `m` and the row `y` with `sql.exec`, applies the flush arm, then burns 100e9 units, far past the 30 s CPU limit, and writes nothing afterwards. The driver (`sync-driver.mjs`, run by `sync-run.sh`) reads the rows back from a fresh stub right after the kill and again 3 s later. The analysis is `sync-analyze.mjs`.

Files:

- `raw-trials.jsonl`: one row per trial, label `grid`.
- `raw-tail.jsonl`: the invocation records from `wrangler tail`, trimmed with `tail-trim.mjs`.
- `summary.txt`: the output of `sync-analyze.mjs` on these files.

## Design

Ten fresh objects per arm, run as two passes of five with the arm order rotated: `none`, `sync`, `syncyield` in pass 0 and `sync`, `syncyield`, `none` in pass 1. Two objects ran at a time. A plain event that commits `m`, `y`, `x`, `z` gated each run, and a smoke run of one object per arm came first.

| Arm         | After writing `m` and `y`                                       | Objects |
| ----------- | --------------------------------------------------------------- | ------: |
| `none`      | burn                                                            |      10 |
| `sync`      | `await storage.sync()`, then burn                               |      10 |
| `syncyield` | `await storage.sync()`, `await scheduler.wait(50)`, then burn   |      10 |

A trial where the request returned instead of being killed counts as `injected: false` and leaves the arm's n. There were none.

Predictions, written before the run: `none` loses `m` and `y` in 10 of 10, as the CPU DURING cell of `reset-commit` did. `sync` and `syncyield` keep both rows, with no prediction on the exact rate. A result where `sync` loses the rows and `syncyield` keeps them would mean the yield, not the flush, commits.

## Results

Rows of the killed event, read from a fresh stub. Wilson 95% intervals.

| Arm         | n  | Injected false | Rows after the kill | Both rows kept       | Rows 3 s later |
| ----------- | -: | -------------: | ------------------- | -------------------- | -------------- |
| `none`      | 10 | 0              | none: 10            | 0/10 [0.0%, 27.8%]   | none: 10       |
| `sync`      | 10 | 0              | `my`: 10            | 10/10 [72.2%, 100%]  | `my`: 10       |
| `syncyield` | 10 | 0              | `my`: 10            | 10/10 [72.2%, 100%]  | `my`: 10       |

The rows agreed across both passes in every arm (5 and 5). The caller and the tail disagree on the kill text, as in `reset-commit`:

| Arm         | Result at the caller             | Tail outcome for the killed request |
| ----------- | -------------------------------- | ----------------------------------- |
| `none`      | storage timeout text: 10         | `exceededWallTime`: 10              |
| `sync`      | CPU time limit text: 10          | `exceededCpu`: 10                   |
| `syncyield` | CPU time limit text: 10          | `exceededCpu`: 10                   |

Every tail exception reads "Durable Object exceeded its CPU time limit and was reset." Every first read after the kill succeeded on the first attempt. The first read reported a different isolate id for each of the 10 objects in every arm.

## Reading

`await storage.sync()` committed the writes before it. A CPU kill that followed it with no further yield kept `m` and `y` in 10 of 10 trials, and the control arm without the flush lost both in 10 of 10. The `syncyield` arm gave the same rows as `sync`, so the 50 ms yield added nothing once the flush had run.

The caller's error text split with the arm: the arms with a flush reported the CPU limit and the tail's `exceededCpu`, and the control reported the storage timeout text and `exceededWallTime`. This repeats the correlation `reset-commit` found between the two. This study did not test why.

## Limits

- Ten objects per arm. A rate of 10 of 10 has a Wilson lower bound of 72.2%, so a failure rate of a few percent is not excluded.
- One kill shape: two `sql.exec` writes and the flush, then CPU burn. It does not cover a flush after a `transactionSync`, a larger write, or a kill by memory or storage reset.
- The burn unit was not calibrated. The platform killed the request at about 32 s of CPU in every trial.
- The read-back returns the rows the successor sees. It does not show whether the writes reached disk before the kill or were recovered afterwards.
- Run on one Worker deployment on one day, from one client host over the public Worker route.
- The smoke run (one object per arm, same Worker, a first deploy) gave the same rows: `none` none, `sync` `my`, `syncyield` `my`. Its teardown hit a DNS failure and the Worker was deleted by hand on retry. The records of that run are not exported.

## How to Reproduce

Summary, from the repository root:

```sh
d=$(mktemp -d)
cp results/continuation/sync-commit/raw-trials.jsonl "$d/trials.jsonl"
node experiments/alarm-retirement/sync-analyze.mjs "$d" results/continuation/sync-commit/raw-tail.jsonl \
	> results/continuation/sync-commit/summary.txt
```

The raw tail is made from the `wrangler tail --format json` output of the run's Worker:

```sh
node experiments/alarm-retirement/tail-trim.mjs <tail-full.jsonl> \
	> results/continuation/sync-commit/raw-tail.jsonl
```

The deployed run needs a Cloudflare account and the `wrangler` CLI. `sync-run.sh` deploys one Worker, runs `sync-driver.mjs` in the mode `smoke` or `full`, and deletes the Worker in its exit trap.
