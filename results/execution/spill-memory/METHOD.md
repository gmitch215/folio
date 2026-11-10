# Spill Memory: Method

## Question and fixture

The fixture is the spill script of `experiments/elastic-limits/`: one Worker with one Durable Object class per arm (25 to 28 classes) and a set of idle controls. A class keeps a previous object's memory in its meter row for about a minute, so one class holds one arm and every arm has a control class. `CONTROL_OF` in `config.ts` maps each arm class to its control. A spill of N MiB writes N MiB of rows of one stated size through `sql.exec`, `put` or, for the fill-only control, nothing. The procedure is the one in the README.

Each arm states a prediction and the number that refutes it before the run.

## Limits and budget

Read before any live run:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): 128 MB per isolate.
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/): default DO CPU allowance 30 seconds per request.
- [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): Free includes 100,000 requests a day and 100,000 rows written. Quotas are account-wide.

A rung with more than 8,000 planned rows needs a raised `--row-cap`. The caps and planned counts of each run are in its `budget.json`. The planning limit is 80,000 rows written per UTC day across every study on the account. Expected direct spend is $0 on the Free plan.

## Runs and harness versions

| Directory        | Rung | Command (from the harness directory)       | Row cap | Deployed worker SHA-256 (first 12) | Harness copy in `source/`                         |
| ---------------- | ---- | ------------------------------------------ | ------: | ---------------------------------- | ------------------------------------------------- |
| `restart-rows`   | 6c   | `live.ts --rungs 6c --row-cap 17000 --approved` |  17,000 | `651e2d3ea2d3`                  | `source/size-and-restart/worker-ladder.mjs`       |
| `size-ladder`    | 6b   | `live.ts --rungs 6b --approved`            |   8,000 | `651e2d3ea2d3`                     | `source/size-and-restart/worker-ladder.mjs`       |
| `row-size-sweep` | 6d   | `live.ts --rungs 6d --row-cap 30000 --approved` | 30,000 | `e1c13213f6e3`                   | not preserved                                     |
| `row-size-cliff` | 6e   | `live.ts --rungs 6e --row-cap 46500 --approved` | 46,500 | `e34b3053fa4e`                   | `source/row-size/worker-ladder.mjs`               |

The deployed worker hash is `workerSha256` in each `source.json`. Three of the four hashes equal the SHA-256 of a preserved worker file. The deployed worker of `row-size-sweep` is an earlier file than `source/row-size/`: the 6e version added three classes (`Rows8k`, `Rows6k`, `Big4k`) to the 25 classes of the 6d script. `source/size-and-restart/` and `source/row-size/` are the last state of those versions, without their tests and notes. As in the platform-ladder study, only the worker files are tied to a run by hash.

Rung 6 data is in `../platform-ladder/spill-pilot` and `../platform-ladder/ladder`, harness version `source/ladder/` there.

Deviations from the plan:

- `restart-rows` lost 13 minutes to a network failure on the client machine. The 4 KiB and 1 MiB small-row arms of repeat 0 completed their spill (status 200) but every hold and clear attempt returned status 0, so their R values (1.875 and 16.0) come from the meter minutes of those failed holds, which include the spill minute. The +20 minute reading of repeat 0 did not complete either (three attempts at status 0). The row cap then stopped repeat 1 before its small-row and second-object arms. The clear of both small-row objects never completed. The counter charges a failed call its worst case, so it reached 16,970 rows while the platform counted 4,314 written. Later versions of the runner wait a minute and retry a call that failed before any response.
- `size-ladder` had one propagation 404 on a hold and one hold cut at status 0 in the drop arm of repeat 0, both retried. The cut hold's window is part of the drop result.
- `row-size-sweep` deployed 25 classes and the namespace listing returned 20. The rows of the other five came from `meter-unlisted.json`, read with `experiments/elastic-limits/recover-meter.ts` after the run.
- A spill that writes 4 KiB rows through `sql.exec` writes 2 schema rows once per object. The counts include them.

## Procedure

The live scripts live in `experiments/elastic-limits/`. A run needs the Free credential pair and writes to `experiments/elastic-limits/runs/`, which is git-ignored:

```sh
node experiments/elastic-limits/live.ts --rungs 6d --row-cap 30000
FREE_CLOUDFLARE_ACCOUNT_ID=... FREE_CLOUDFLARE_API_TOKEN=... node experiments/elastic-limits/live.ts --rungs 6d --row-cap 30000 --approved
node experiments/elastic-limits/recover-meter.ts RUN_DIRECTORY SINCE UNTIL
node experiments/elastic-limits/live.ts --cleanup NAME --group spill --baseline SHA256
```

Without `--approved` the command prints the price and touches no network. A live run snapshots the account inventory, deploys, runs the arms, reads the meter until two reads in a row agree, retires the classes and checks the inventory against the baseline. This study was not rerun for promotion. Do not run it without the credential pair and an explicit go. Check the day's row total first.

## Offline analysis

```sh
node scripts/research/elastic-limits-summary.ts results/execution/spill-memory
```

It reads the four run directories and rung 6 from `../platform-ladder`. R is the class's largest sample in the minutes from `startMinute` to `endMinute` of a hold, minus the control's largest sample in its own hold minutes. Meter rows for the five unlisted classes are assigned by order of first spill, and the summary asserts each class's first-minute rows written equal the spill's rows plus schema rows (4,098, 1,026, 258, 66 and 18). `experiments/elastic-limits/analyze.ts` prints the same tables per run directory and was used to cross-check the summary.

## Harness lessons

- The namespace listing returns 20 rows by default. `row-size-sweep` deployed 25 classes and listed 20. The fix (`per_page=100`) is in `source/row-size/meter.ts` and the current harness, and `row-size-cliff` listed all 28 classes.
- A failed call is charged its worst case. A counter above the meter's rows written means failed calls, not extra writes.
- In the rung 6 raw lines of the platform-ladder runs, `rows` holds the planned row count, because the extra fields spread over it. Rungs 6b to 6e keep the plan in `planned` and the observed count in `rows`.
- A class keeps the previous object's memory in its meter row for about a minute. One class per arm avoids the overlap between arms. Two objects of one arm in one class (repeats) still share a class, so `afterClear` lists the minutes after each clear.
- A short-lived object may publish no meter row. A missing row is not a reading of zero.

## Predictions

Written before each run in a file that is not promoted (it names files outside the repository). Its SHA-256 is `c1ec764528ca0f976727df2db752fa5ba8f45899f64e7b0b39b8e86ea685c3ad` for the version that ends with the 6b and 6c notes and `fae3c3cf1d558f8c3ee791c393b4991bf9448a2c92409f3ee8ef94f38a3d9a32` for the final version that adds 6d and 6e. "Hit" means the stated band held. A hit at the edge of a band says so.

| Rung | Prediction                                                                                  | Outcome                                                               | Score |
| ---- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----- |
| 6    | Fill-only arm reads like the spill arms (harness garbage), at least 32 MiB                  | 2.0 MiB                                                               | Miss  |
| 6    | Fill-only idle control 1.5 MiB, refuted above 5.5                                           | 1.5 MiB                                                               | Hit   |
| 6b   | Proportional (0.54 retained) or a cap: R16 in [7, 10] or [14, 18]                           | 16.0                                                                  | Cap hit |
| 6b   | R32 in [14, 21] or [29, 35]                                                                 | 2.5                                                                   | Both missed |
| 6b   | R64 about 34.5 (reproduction)                                                               | 34.5                                                                  | Hit   |
| 6b   | R128 in [56, 82] or [28, 37]                                                                | 32.5                                                                  | Cap hit |
| 6b   | R256 in [113, 164] or [28, 37]                                                              | 28.5                                                                  | Cap hit |
| 6b   | Put at 128 within 3 MiB of `sql.exec`, refuted above 8                                      | 32.5 against 32.5                                                     | Hit   |
| 6b   | Read-back at 64 within 3 MiB of the 64 MiB object                                           | 31.5 against 34.5                                                     | Hit, at the edge |
| 6b   | Drop arm releases (proportional) or retains (cap)                                           | Released in repeat 0, retained in repeats 1 and 2                     | Miss for both |
| 6b   | No exceeded-memory or exceeded-CPU rows, every spill 200                                    | 0 rows, 24 of 24 spills 200                                           | Hit   |
| 6c   | Restart: R at +5 in [30, 36] and R at +15 at most 4, both repeats                           | R 0.0 at +5, on the same instance                                     | Miss  |
| 6c   | Small rows: R of 4 KiB rows at most 4 and R of extents in [8, 16]                           | 1.875 and 16.0                                                        | Hit, extents at the edge |
| 6c   | Second object: writer in [25, 40], caller at most 4                                         | 34.5 and 0.094                                                        | Hit   |
| 6d   | 16 MiB, 4 KiB rows: R at most 4, both repeats                                               | 1.945 and 1.945                                                       | Hit   |
| 6d   | 16 MiB, 16 KiB rows in [3, 8]                                                               | 16.25                                                                 | Miss  |
| 6d   | 16 MiB, 64 KiB rows in [6, 14]                                                              | 16.0                                                                  | Miss  |
| 6d   | 16 MiB, 256 KiB rows in [10, 16]                                                            | 16.0                                                                  | Hit, at the edge |
| 6d   | 16 MiB, 1 MiB extents in [14, 18], both repeats                                             | 16.0 and 16.0                                                         | Hit   |
| 6d   | Medians rise with row size                                                                  | 1.945, 16.25, 16.0, 16.0, 16.0                                        | Hit (largest fall 0.25) |
| 6d   | 64 MiB, 64 KiB rows at most 12; 16 KiB rows at most 8                                       | 32.625 and 33.031                                                     | Miss, both |
| 6d   | Decay: spill minute and first hold in [30, 36]                                              | 34.5, both repeats                                                    | Hit   |
| 6d   | Decay: minute 5 onward at most 4 on a live instance                                         | 34.5 in every hold window                                             | Miss  |
| 6d   | Decay: minutes 2 to 4 non-increasing; repeats agree within 6 at minute 1                    | constant 34.5; gap 0                                                  | Hit   |
| 6d   | Second object: writer in [25, 40], caller at most 4                                         | 34.5 and 0.094                                                        | Hit   |
| 6d   | Meter rows written equal planned writes plus schema rows within 2                           | equal for every class                                                 | Hit   |
| 6e   | 16 MiB, 8 KiB rows in [14, 18], both repeats, within 6 of each other                        | 16.25 and 16.25                                                       | Hit   |
| 6e   | 16 MiB, 6 KiB rows in [14, 18]                                                              | 16.496                                                                | Hit   |
| 6e   | 64 MiB, 4 KiB rows at most 4, refuted at 8 or more                                          | 12.238                                                                | Miss  |
| 6e   | Meter rows written equal planned writes plus schema rows within 2                           | equal for every class                                                 | Hit   |
| 6e   | A script of 28 classes deploys                                                              | accepted                                                              | Hit   |

## Evidence and redaction

- `raw.jsonl` in each run directory has one line per client call. The module identifier in the `isolate` and `ownerIsolate` fields is replaced by an ordinal in order of first appearance, so two lines with the same module still compare equal. The identifier is a random id made when the module loads, not an isolate identity. The original size and SHA-256 of each file are in `redaction.json`.
- `namespaces.json` is reduced to the count and the class names. The originals hold namespace identifiers and are not promoted. Their SHA-256 values are in `redaction.json`.
- `meter.json`, `meter-unlisted.json`, `counters.json`, `budget.json`, `cleanup.json` and `source.json` are unchanged from the run. `meter-unlisted.json` labels its namespaces `unknown-0` to `unknown-4` and holds no identifier. `source.json` names the throwaway Worker script, which holds no account identifier.
- Nothing here holds an account identifier, a token or a workers.dev host. `scripts/research/redaction-scan.ts` reports 0 findings over this directory.

## Frozen source

`source/size-and-restart/` is the harness at the last state of the version that ran rungs 6b and 6c. `source/row-size/` is the last state of the version that ran rung 6e and added the namespace paging fix. `experiments/elastic-limits/` holds the current version, whose files are restyled. The current worker files differ from the deployed bytes in whitespace only, so a rerun deploys a different `workerSha256`.
