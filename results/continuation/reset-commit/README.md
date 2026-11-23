# Reset Commit

What does a Durable Object reset commit, and what does the first request after a reset cost?

## Instrument

A Durable Object class `M1` (`experiments/alarm-retirement/m1-worker.mjs`, config `m1-wrangler.jsonc`) runs
each event as a sequence of writes and effects. The marker `m` and the row `y` are written before a yield,
`x` and `z` after it. The driver (`m1-driver.mjs`, run by `m1-run.sh`) triggers a reset in the same request
and reads the rows back from a fresh stub, once right after the reset and once 3 s later. The successor cost
comes from the first successful read after the reset against the next read on the same object.

The analysis is `m1-analyze.mjs`. It reads the trial and chain records and the tail, and prints the summary.

Files:

- `raw-trials.jsonl`: one row per trial (`gate` and `grid` labels).
- `raw-chains.jsonl`: one row per storage chain, arms `m1` (spec shape), `orig` (control) and `nowait`.
- `raw-tail.jsonl`: the invocation records from `wrangler tail`, trimmed (see Limits).
- `summary.txt`: the output of `m1-analyze.mjs` on these files.

## Design

| Kind    | Variant | Trigger                                                    | Chains or trials |
| ------- | ------- | ---------------------------------------------------------- | ---------------: |
| memory  | during  | 8 x 32 MiB held before the yield                           | 10               |
| memory  | after   | the same memory held after `z`                             | 10               |
| CPU     | during  | 100e9 burn units between `y` and the yield                 | 10               |
| CPU     | after   | the same burn after `z`                                    | 10               |
| storage | m1      | spec shape: `m`, `y`, burn, 50 ms wait, `x`, `z`, alarm    | 20 chains        |
| storage | nowait  | `m`, `y`, burn, `x`, `z`, alarm, no yield                  | 20 chains        |
| storage | orig    | control: `m`, burn, `x`, alarm                             | 5 chains         |

## Results

Rows of the killed event, read from a fresh stub. The prediction for each kind is that rows committed before
the last yield survive.

| Kind    | Variant | Event result at the caller                  | Rows after the reset | Rows 3 s later |
| ------- | ------- | ------------------------------------------- | -------------------- | -------------- |
| memory  | during  | memory limit, 10 of 10                      | `my`: 10             | `my`: 10       |
| memory  | after   | memory limit, 10 of 10                      | `mxyz`: 10           | `mxyz`: 10     |
| CPU     | during  | storage timeout text, 10 of 10              | none: 10             | none: 10       |
| CPU     | after   | storage timeout text 4, CPU text 6          | `my`: 10             | `my`: 10       |

Storage chains:

| Arm     | Chains with a reset (Wilson 95%)   | Rows of the reset event                | Other stops                                  |
| ------- | ---------------------------------- | -------------------------------------- | -------------------------------------------- |
| m1      | 0 of 20 `Internal error` (0 to 16.1%) | none                                | 18 code-update resets, rows `my`: 18         |
| nowait  | 20 of 20 (83.9% to 100%)           | `mxyz`: 19, none: 1                    | none                                         |
| orig    | 4 of 5 (37.6% to 96.4%)            | `mx`: 4                                | none                                         |

In every arm, no ok event before a stop was missing a row: the full set is `mxyz` for `m1` and `nowait`, and `mx`
for `orig`. The counts are 313, 268 and 93 ok events.

Successor cost, from the first successful read after the reset. Medians in milliseconds; `n` is the number of
trials with a CPU reading from the tail. Every first read succeeded on the first attempt.

| Source         | n  | First wall | Warm wall | First CPU (n)  | Warm CPU (n)  | Instance changed at +3 s |
| -------------- | -: | ---------: | --------: | -------------- | ------------- | -----------------------: |
| memory during  | 10 | 231        | 37        | 0 (10)         | 0 (9)         | 0                        |
| memory after   | 10 | 207        | 38        | 0 (10)         | 0 (10)        | 0                        |
| CPU during     | 10 | 205        | 43        | 1 (10)         | 0 (10)        | 0                        |
| CPU after      | 10 | 168        | 45        | 1 (10)         | 0 (10)        | 0                        |
| storage orig   | 4  | 229        | 59        | n/a (0)        | n/a (0)       | 0                        |
| storage nowait | 20 | 244        | 49        | 1 (3)          | n/a (0)       | 0                        |

## Reading

A reset keeps what was committed before the last yield and drops what came after it. Memory resets kept the
marker and the row before the yield in every trial, with or without an await. CPU kills kept rows only when an
await had committed them first. The CPU AFTER cell kept `m` and `y` in 10 of 10 trials, and the CPU DURING
cell kept none of them.

For storage resets, rows of one event landed together or not at all: 19 of 20 `nowait` resets kept `mxyz`,
and the one other kept none. The spec shape stopped with a code-update error in 18 of 20 chains and kept the
marker while dropping the effect.

The median CPU of the first request after a reset was 0 or 1 ms, which the tail's whole-millisecond reading
cannot separate from a warm read. Its
median wall time was about 120 to 195 ms above the warm read. No first read failed, so no retry window was
needed in any trial.

## Limits

- The spec shape never produced an `Internal error` reset. Its stops were code-update errors. The `nowait`
  arm was added after that result, with the same rows and burn and no yield. It is a design change, and the
  spec shape's data stays in the table.
- The control arm (`orig`, 5 chains) is not in the original design.
- The memory trigger is 8 chunks of 32 MiB held in one request. The CPU trigger is 100e9 burn units. The burn
  unit was not calibrated.
- CPU readings come from the tail, which lost events. Successor CPU for storage resets rests on 3 samples
  (`nowait`) and none for the control. The wall times are complete.
- A reset is counted when the caller receives the error. The reset event returns no body, so the instance
  id before and after a memory or CPU reset is not compared. The instance id was equal at the first read and
  at +3 s in all 40 trials.
- The control arm has 5 chains, so its interval is wide. The memory and CPU cells have 10 trials each, and
  their reset counts (10 of 10) carry a lower bound of 72.2% under the Wilson 95% interval.
- The tail was trimmed with `tail-trim.mjs`. The trimmed file gives the same analyzer output as the full tail.
  The one difference is the header count of tail records, which counts the trimmed records.

## How to Reproduce

Summary, from the repository root:

```sh
d=$(mktemp -d)
cp results/continuation/reset-commit/raw-trials.jsonl "$d/trials.jsonl"
cp results/continuation/reset-commit/raw-chains.jsonl "$d/chains.jsonl"
node experiments/alarm-retirement/m1-analyze.mjs "$d" results/continuation/reset-commit/raw-tail.jsonl \
	> results/continuation/reset-commit/summary.txt
```

The raw tail is made from the `wrangler tail --format json` output of the run's Worker:

```sh
node experiments/alarm-retirement/tail-trim.mjs <tail-full.jsonl> <tail-nowait.jsonl> \
	> results/continuation/reset-commit/raw-tail.jsonl
```

The deployed runs need a Cloudflare account and the `wrangler` CLI. The harness deploys one Worker, runs
`m1-driver.mjs` in one of the modes `smoke`, `full` or `nowait`, and deletes the Worker in its exit trap.
