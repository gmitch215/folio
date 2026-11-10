# Spill Memory

Question: when a Durable Object writes a large amount of data to its own storage, how much memory does the platform meter hold against that object, on which object, for how long, and how does it depend on the size of the spill and the size of each row?

This matters to any design that spills memory pages to the storage of the object that runs the program. A storage tier saves isolate memory only if the bytes written stop counting against it.

Result: the meter holds up to a ceiling near 36 MiB for the writing object, on the writing object and not on its caller. Rows of 6 KiB or more hold everything written up to that ceiling. Rows of 4 KiB hold 1.9 MiB of 16 MiB written and 12.2 MiB of 64 MiB written. The held memory does not decay while the object keeps receiving requests, and every reading taken five minutes or more after a spill was 0.0. The curve against spill size is not proportional and not a clean plateau: 32 MiB reads 2.5 MiB in all three repeats. Each cell has its n below, and most have one to three.

## Inputs

| Directory        | Rung | Started (UTC)    | Client requests | Rows counted | Meter rows | Note                                              |
| ---------------- | ---- | ---------------- | --------------: | -----------: | ---------: | ------------------------------------------------- |
| `restart-rows`   | 6c   | 2026-11-05 22:21 |              53 |       16,970 |         36 | stopped by the row cap in its second repeat       |
| `size-ladder`    | 6b   | 2026-11-05 23:34 |              83 |        4,554 |         60 |                                                   |
| `row-size-sweep` | 6d   | 2026-11-06 00:40 |              56 |       29,784 |         32 | five classes recovered from `meter-unlisted.json` |
| `row-size-cliff` | 6e   | 2026-11-06 01:38 |              14 |       46,428 |         10 |                                                   |

Rung 6, the first spill of 64 MiB, is in the [platform-ladder](../platform-ladder/README.md) runs `spill-pilot` and `ladder`, and this study reads those raw files from there. The account inventory equaled its baseline after every run.

## Instrument

`experiments/elastic-limits/` deploys a spill script with one class per arm, so every meter row belongs to one arm. A spill writes rows of a stated size through `sql.exec`, or through unawaited `put`. A hold keeps the object busy for 70 s so the per-minute meter samples it. The platform meter is the account GraphQL dataset `durableObjectsPeriodicGroups`, field `max { memoryUsageBytes }`, per class and minute.

R is the class's largest meter sample in the minutes of the hold, minus the largest sample of the class's idle control, which is a hold on an object that wrote nothing. Every control read 1.5 MiB. MiB are rounded to three decimals in `summary.json`.

## Results

### Rung 6: a 64 MiB spill, three ways

64 MiB in 1 MiB extents, three repeats per arm, in `spill-pilot` and `ladder`. All six `sql.exec` and all six `put` objects read 36.0 MiB on the meter against 1.5 MiB for the class control, so R is 34.5 MiB in both arms and in every repeat. The fill-only arm fills the same buffers and writes nothing: its class read 2.0 MiB in three objects (R 0.5). The writes cause the rise, not the harness. The two storage paths do not differ.

Spill wall time in the `ladder` run: `sql.exec` 1.22 to 1.75 s, unawaited `put` 1.27 to 2.72 s, fill-only 0.47 to 0.69 s, n = 3 each. Other classes that wrote blobs in the same run read 33.1 MiB (the rung 1 owner, 4,802 rows) and 29.7 MiB (the rung 5 store, 759 rows).

### Rung 6b: size of the spill

1 MiB extents through `sql.exec`, three repeats per size, one class per size. The values were identical in all three repeats.

| Spilled | Path          | R, MiB |
| ------: | ------------- | -----: |
|  16 MiB | `sql.exec`    |   16.0 |
|  32 MiB | `sql.exec`    |    2.5 |
|  64 MiB | `sql.exec`    |   34.5 |
| 128 MiB | `sql.exec`    |   32.5 |
| 256 MiB | `sql.exec`    |   28.5 |
| 128 MiB | unawaited `put` |  32.5 |
|  64 MiB | `sql.exec`, read back once | 31.5 |

The held memory is bounded near 36 MiB. It is not larger for 256 MiB than for 64 MiB, it is not proportional (0.54 of the bytes would give 138 MiB at 256) and the 32 MiB cell is low in every repeat. The cause of the low cell is unknown. Reading the data back adds nothing.

Drop arm (64 MiB, hold, clear, then a 130 s tail on the same object), n = 3: in repeat 0 the first hold window ran three minutes at 34.5 MiB and the retry hold after it read 1.5 MiB (R 0.0), with the tail also at 1.5. In repeats 1 and 2 the hold and the two-minute tail after the clear read 34.5 MiB. Deleting the storage did not release the memory in two of three repeats. The release in repeat 0 came about three minutes after the spill.

### Rung 6c: restart, small rows and a second object

n = 1 or 2 per cell. The run lost 13 minutes to a network failure on the client machine, and the row cap stopped it in its second repeat.

| Arm                                 | R, MiB | n | Note                                            |
| ----------------------------------- | -----: | -: | ----------------------------------------------- |
| 64 MiB as 1 MiB extents, hold minute | 34.5, 34.5 | 2 | restart arm                                  |
| same object, readings at +5, +10, +15, +20 minutes | 0.0 | 9 | 7 completed holds and 2 failed attempts that still show a meter row |
| second object: writer class         |   34.5 | 1 | the executor forwarded spill, hold and clear    |
| second object: caller class         |  0.094 | 1 |                                                 |
| 16 MiB as 4 KiB rows                |  1.875 | 1 | the hold request failed; the reading is the spill minute |
| 16 MiB as 1 MiB extents             |   16.0 | 1 | the hold request failed; the reading is the spill minute |

Of the seven completed readings after the spill, two ran on a fresh instance of the object's module (repeat 0, +10 and +15 minutes). The other five (repeat 0 at +5 and repeat 1 at +5, +10, +15 and +20) ran on the same instance that wrote. The +20 reading of repeat 0 never completed. All read 0.0. The memory is therefore released by time while the instance stays up, and a fresh instance starts clean. The two fresh readings are the whole evidence about a restart.

The memory lands on the writing object (34.5) and not on the caller (0.094). A dedicated owner object absorbs the memory at the price of a stub call per spill step.

### Rungs 6d and 6e: size of each row

`sql.exec`, one 70 s hold per object, one class per arm.

| Written | Row size   |     R, MiB | n | Run              |
| ------: | ---------- | ---------: | -: | ---------------- |
|  16 MiB | 4 KiB      |      1.875 | 1 | `restart-rows`   |
|  16 MiB | 4 KiB      |      1.945 | 2 | `row-size-sweep` |
|  16 MiB | 6 KiB      |     16.496 | 1 | `row-size-cliff` |
|  16 MiB | 8 KiB      |     16.25  | 2 | `row-size-cliff` |
|  16 MiB | 16 KiB     |     16.25  | 1 | `row-size-sweep` |
|  16 MiB | 64 KiB     |     16.0   | 1 | `row-size-sweep` |
|  16 MiB | 256 KiB    |     16.0   | 1 | `row-size-sweep` |
|  16 MiB | 1 MiB      |     16.0   | 2 | `row-size-sweep` |
|  64 MiB | 4 KiB      |     12.238 | 1 | `row-size-cliff` |
|  64 MiB | 16 KiB     |     33.031 | 1 | `row-size-sweep` |
|  64 MiB | 64 KiB     |     32.625 | 1 | `row-size-sweep` |
|  64 MiB | 1 MiB      |      34.5  | 5 | `size-ladder` (3), `restart-rows` (2) |

- The cliff is between 4 KiB and 6 KiB. Any row of 6 KiB or more holds all bytes written, up to the ceiling. Rows of 4 KiB hold 0.12 of the bytes at 16 MiB (1.945 of 16) and 0.19 at 64 MiB (12.238 of 64).
- Decay arm, 64 MiB in 1 MiB extents, then seven back-to-back holds, two repeats: R was 34.5 MiB in all 14 hold windows over about eight minutes, and the class published no row after the final clear. The held memory goes with how long the object stays busy. It does not decay on a live object.
- Second object once more: writer 34.5 MiB, caller 0.094 MiB (n = 1).
- For every class in the four runs, the rows the platform counted equal the rows and schema rows the completed spills reported, for example 4,098 for the 4 KiB class at 16 MiB.

## Prediction misses

Scoring of every stated band is in [METHOD](METHOD.md). The misses:

- The fill-only arm was predicted to read like the spill arms (harness garbage). It read 2.0 MiB.
- 4 KiB rows at 64 MiB were predicted at 4 MiB or less. They read 12.2.
- 16 KiB rows at 16 MiB were predicted at 3 to 8 MiB and 64 KiB rows at 6 to 14. They read 16.25 and 16.0.
- 64 KiB and 16 KiB rows at 64 MiB were predicted at 12 and 8 MiB or less. They read 32.6 and 33.0.
- The retained-or-proportional pair for the spill size missed at 32 MiB (2.5), and the drop arm was neither released nor retained.
- Decay by time was predicted from minute 5 on. The decay arm showed no decay while the object stayed busy.
- The restart arm predicted 30 to 36 MiB at +5 minutes. It read 0.0, on the same instance.

## Reproduction

From the repository root, with Node 26:

```sh
node scripts/research/elastic-limits-summary.ts results/execution/spill-memory
node experiments/elastic-limits/analyze.ts results/execution/spill-memory/size-ladder
node scripts/research/evidence.ts
```

The summary reads `../platform-ladder` for rung 6. It writes `summary.json` when missing and compares it when present. `row-size-sweep` needs `meter-unlisted.json`: the summary assigns its five unnamed namespaces to the classes that have no row in `meter.json`, in order of first spill, and asserts each one's rows written. A live rerun is described in [METHOD](METHOD.md).

## Artifacts

- `summary.json`: R per hold and per arm with its n, controls, the minutes after each clear, the decay table, the rows cross-check and rung 6 per object.
- `restart-rows/`, `size-ladder/`, `row-size-sweep/`, `row-size-cliff/`: per run `raw.jsonl`, `meter.json`, `counters.json`, `budget.json`, `cleanup.json`, `source.json` and `namespaces.json`. `row-size-sweep/meter-unlisted.json` holds the five namespaces the run did not list.
- `redaction.json`: original size and SHA-256 of each redacted file.
- `source/size-and-restart/` and `source/row-size/`: the harness files of the versions that produced these runs.
- `manifest.json`: bytes and SHA-256 of every file here.

## Scope

- One Free account, one colo, one afternoon. The meter is a per-minute sample per class and is a lower bound on the peak.
- Most cells have one to three repeats and no cell has more than five.
- Row sizes between 1 KiB and 4 KiB, row counts above 16,384 and objects of other classes were not tested.
- The ceiling near 36 MiB is the largest reading in the three runs that spilled 64 MiB or more. Whether the platform's 128 MB limit counts the held memory was not tested.
- Nothing here shows how the memory is released, or why 32 MiB reads low.
