# Platform Ladder: Method

## Question and fixture

The fixture is a throwaway Worker per script group, each with Durable Object classes. The `ladder` script holds `Executor`, `Owner`, `Store`, `Burner`, `SpillSql`, `SpillPut` and `SpillNone` (rungs 1 to 6). The `mem` script holds 26 classes, `M00` to `M25` (rung 7). Rungs 6b to 6e run in a third script and belong to [spill-memory](../spill-memory/README.md).

Each rung states a prediction and the number that refutes it before the run. The procedure is the one in the README.

## Limits and budget

Read before any live run:

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/): Free HTTP CPU allowance 10 ms; 128 MB per isolate; 50 external and 1,000 internal subrequests per request.
- [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/): default DO CPU allowance 30 seconds per request.
- [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/): Free includes 100,000 requests a day and 100,000 rows written. Quotas are account-wide.

`budget.json` in each run directory holds the config and the planned counts. The runner aborts before a call that would pass 8,000 rows written or 1,500 client requests, and refuses to start when today's rows written plus the plan pass 80,000. Expected direct spend is $0 on the Free plan. Logical counts are not billed totals, and the meter lags and undercounts them.

## Runs and harness versions

| Directory     | Command (from the harness directory)  | Deployed worker SHA-256 (first 12) | Harness copy in `source/`            |
| ------------- | ------------------------------------- | ---------------------------------- | ------------------------------------ |
| `cpu-cap`     | `live.ts --rungs 4 --approved`        | `bc26929246a6`                     | not preserved                        |
| `spill-pilot` | `live.ts --rungs 6 --approved`        | `bc26929246a6`                     | not preserved                        |
| `ladder`      | `live.ts --rungs 5,6,4,1,2,3 --approved` | `ec116e8b9ea9`                  | `source/ladder/worker-ladder.mjs`    |
| `memory`      | `live.ts --rungs 7 --approved`        | `0599fb3e2ac8`                     | `source/ladder/worker-mem.mjs`       |

The deployed worker hash is `workerSha256` in each `source.json`. For `ladder` and `memory` it equals the SHA-256 of the copy in `source/ladder/`, which the analysis does not check. For the first two runs the deployed worker is an earlier file than any preserved copy: it predates the fill-only arm of rung 6 (`SpillNone`), which `ladder` added. The TypeScript files in `source/ladder/` are the last state of that version. Only the two worker files are tied to a run by hash, so the runner and plan files are the version that ran `ladder` as far as the notes say, not as far as a hash shows.

The first run predates `namespaces.json` and the aggregate cross-check, which is why `cpu-cap` has no namespace listing. Start times are in the raw lines.

Deviations from the plan:

- Rung 4 ran alone first (`cpu-cap`) because a CPU cap would have killed the rung 1 and rung 6 fills. Its meter returned no row in 12 polls over 15 minutes. The objects lived about 30 s. `spill-pilot` showed the meter does publish rows for a class held 70 s, so the empty meter belongs to short-lived objects or to the query form, which was not separated.
- Rung 6 ran alone once (`spill-pilot`) before the full ladder, to settle the first meter reading. The full ladder repeated it with the fill-only arm.
- Rung 7 ran last, not between rungs 1 and 2, because each group is its own script.
- Two of five 70 s hold requests in `ladder` (and one in `spill-pilot`) were cut at 58 to 59 s with status 0 and succeeded on retry. This is a client or network artifact, not a limit that was identified.

## Procedure

The live scripts live in `experiments/elastic-limits/`. A run needs the Free credential pair and writes to `experiments/elastic-limits/runs/`, which is git-ignored:

```sh
node experiments/elastic-limits/live.ts --rungs 5,6,4,1,2,3
FREE_CLOUDFLARE_ACCOUNT_ID=... FREE_CLOUDFLARE_API_TOKEN=... node experiments/elastic-limits/live.ts --rungs 5,6,4,1,2,3 --approved
node experiments/elastic-limits/live.ts --cleanup NAME --group ladder --baseline SHA256
```

Without `--approved` the command prints the price and touches no network. A live run snapshots the account inventory, deploys, runs, reads the meter until two reads in a row agree, retires the classes and the Worker, and checks the inventory against the baseline. This study was not rerun for promotion. Do not run it without the credential pair and an explicit go.

## Offline analysis

```sh
node scripts/research/elastic-limits-summary.ts results/execution/platform-ladder
```

It reads the four run directories, writes `summary.json` only when the file is missing and otherwise compares the regenerated summary with it. Rung 1 nets are the median of a cell minus the median of the run's no-op request. Rung 5 slopes are per repeat. Rung 7 cells are the class maximum of the meter, `null` where the meter has no row for the class. `experiments/elastic-limits/analyze.ts` prints the same tables for one run directory and was used to cross-check the summary.

## Harness lessons

- The namespace listing returns 20 rows by default. `memory` deployed 26 classes and listed 20, so six classes (`M20` to `M25`) have no meter rows. `ladder` deployed 7 classes and is not affected. The listing fix (`per_page=100`) came after these runs and is in `experiments/elastic-limits/meter.ts`.
- A failed call is charged its worst case. `counters.json` therefore counts more rows than were written when a call fails. In `spill-pilot` the counter shows 838 rows against 774 planned: a clear that failed at the transport was charged its 64 rows and charged again on retry (448 cleanup rows against 384 planned). The meter shows 390 rows written there, the writes plus schema rows. In `ladder` the counter shows 6,386 rows, equal to the plan, and the meter shows 5,951 rows written. The 435 rows between them equal the counted cleanup rows: the meter published none for storage cleared with `deleteAll`.
- In the rung 6 raw lines of `spill-pilot` and `ladder`, the field `rows` holds the planned row count, because the extra fields spread over it. `sqlRows` holds the rows the object reported and `counters.json` is correct. Rungs 1 to 5 and 7 are not affected.
- A class keeps the previous object's memory in its meter row for about a minute. Rung 6 uses one class per mode, so the second and third object of a mode can inherit the previous one. `summary.json` lists each object's window.

## Predictions

Written before each run in a file that is not promoted (it names files outside the repository). Its SHA-256, for the first version, is `0559b8bef8a0b2b5747b177e978e6b5b1d61431708bd346c30303663a80a10de`. Each line below is scored against `summary.json`.

| # | Prediction                                                                                      | Outcome                                                                          | Score |
| - | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----- |
| 1 | Awaited `put` about 20 ms each at every size; 16 unawaited `put` cost about one flush; refuted if the 256 KiB cost per put exceeds twice the 1 KiB cost or the unawaited batch costs at least half the awaited total | Awaited net per write 1.60 to 5.22 ms; 256 KiB over 1 KiB is 1.4 times; unawaited 84.1 ms against awaited 83.5 ms at 256 KiB | Miss: the unawaited batch rule fired |
| 1 | `sql.exec` matches the unawaited batch within 10 ms                                             | Differs by 4.5 ms at 1 KiB, 1.3 to 3.8 ms at 4 to 64 KiB, 6.95 ms at 256 KiB    | Hit   |
| 2 | Hop 9 to 11 ms for `fetch`, about the same for RPC; refuted under 3 ms                           | `fetch` median 10 ms, RPC 7 ms                                                   | Hit for `fetch`, RPC lower |
| 2 | A hint shrinks the 55 ms offset between executors                                                | Offset did not appear: every object in one colo                                  | Not testable |
| 2 | Own-stub and local calls under 1 ms                                                              | Own stub median 3 ms, local 0 ms                                                 | Miss for own stub |
| 3 | The 1,000 sequential calls, the 33 RPC calls and 16 at once all succeed                         | The 1,001st stub call failed; 33 and 16 succeeded                                | Miss by one call |
| 4 | 50 ms and 200 ms CPU-bound requests return 200; refuted by any kill                              | 19 of 19 in both runs                                                            | Hit   |
| 5 | A 64 KiB read-modify-write cycle is 0.27 to 0.40 ms; refuted above 5 ms write or 1 ms read       | Slopes 0.134, 0.067 and 0.398 ms; reads not distinguishable from a no-op         | Hit for the refutation rules, two slopes under the range |
| 6 | Spill of 64 MiB leaves the meter within 24 MiB of the idle control; refuted at 48 MiB or more    | 34.5 MiB over the control in both arms (see spill-memory)                        | Miss on the first clause, refutation line not reached |
| 7 | Untouched memory about 0.8 MiB per MiB, written 0.9 to 1.1; written minus untouched under 8 MiB; the 128 MiB cells 51 to 70 MiB above the 64 MiB cells | Slope 1.00 for both, gap 0, cells 64.0 MiB apart                               | Miss on 0.8, hit on the rest |

## Evidence and redaction

- `raw.jsonl` in each run directory has one line per client call and per inner step. The module identifier in the `isolate` and `ownerIsolate` fields is replaced by an ordinal in order of first appearance (`isolate-0`, `isolate-1`), so two lines with the same module still compare equal. The identifier is a random id made when the module loads, not an isolate identity. The original size and SHA-256 of each file are in `redaction.json`.
- `namespaces.json` is reduced to the count and the class names. The originals hold namespace identifiers and are not promoted. Their SHA-256 values are in `redaction.json`.
- `meter.json`, `counters.json`, `budget.json`, `cleanup.json` and `source.json` are unchanged from the run. `source.json` names the throwaway Worker script, which holds no account identifier.
- Nothing here holds an account identifier, a token or a workers.dev host. `scripts/research/redaction-scan.ts` reports 0 findings over this directory.

## Frozen source

`source/ladder/` is the harness at the last state of the version that ran `ladder` and `memory`, without its tests and notes. `experiments/elastic-limits/` holds the current version, which adds the rungs 6b to 6e and the namespace paging fix and has restyled files. The current worker files differ from the deployed bytes in whitespace only, so a rerun deploys a different `workerSha256`.
