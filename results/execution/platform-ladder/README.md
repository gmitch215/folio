# Platform Ladder

Questions, on the Cloudflare Free plan: does an awaited `put` cost more than an unawaited one, what do an executor-to-owner hop and a colocated read-modify-write cost, is there a 10 ms CPU cap on a Durable Object request, how many stub calls can one invocation make, and how does the platform meter charge linear memory?

These measurements test the hypotheses in [latency-anatomy](../elastic-memory/latency-anatomy/README.md), which split the 392 s of the [managed envelope](../elastic-memory/managed-envelope/README.md) run into terms without measuring any of them.

Result: every term of that split was measured on its own and the split's reading of the put changed. Awaiting each `put` costs nothing extra. The durable cost shows up once per request that wrote. A hop is 7 to 10 ms, a colocated 64 KiB read-modify-write cycle is 0.07 to 0.40 ms, a stub call is capped at 1,000 per invocation, there is no 10 ms CPU cap in the range tested, and the platform meter charges linear memory at 1.00 MiB per MiB whether the pages were touched or not. Every figure is one account, one colo and one day, with the repeat counts below.

## Inputs

| Directory     | Started (UTC)    | Rungs          | Client requests | Rows counted | Meter rows (polls to settle) |
| ------------- | ---------------- | -------------- | --------------: | -----------: | ---------------------------- |
| `cpu-cap`     | 2026-11-05 20:15 | 4              |              20 |            0 | none after 12 polls          |
| `spill-pilot` | 2026-11-05 20:32 | 6              |              24 |          838 | 17 (2)                       |
| `ladder`      | 2026-11-05 20:57 | 5, 6, 4, 1, 2, 3 |            430 |        6,386 | 32 (2)                       |
| `memory`      | 2026-11-05 21:28 | 7              |             126 |            0 | 37 (2)                       |

Each directory is one deployment of a throwaway Worker with Durable Object classes, torn down at the end. The account inventory equaled its baseline after all four. `ladder` is the full run and carries every number below except the first CPU result and rung 7. The rung 6 spill data in `spill-pilot` and `ladder` is analyzed in [spill-memory](../spill-memory/README.md).

## Instrument

`experiments/elastic-limits/` deploys, calls and tears down. Every call writes one raw line with client wall time, and calls that time inner steps write one more line per step. `summary.json` comes from `scripts/research/elastic-limits-summary.ts`. Wall times are client wall times of a whole request. The Workers clock does not advance during synchronous work, so inner clock readings of synchronous steps read 0 and are not used.

## Results

### Rung 1: write shapes

Sixteen writes in one owner per request, at five sizes, in three shapes: 16 awaited `put`, 16 unawaited `put` then return, and 16 `sql.exec` blob inserts. Net of a no-op request to the same object (median 54.7 ms, n = 20). Median per cell, n = 20 requests per cell.

| Value size | Awaited `put`, net ms | Unawaited `put`, net ms | `sql.exec`, net ms |
| ---------: | --------------------: | ----------------------: | -----------------: |
|      1 KiB |                  59.0 |                    54.7 |               50.3 |
|      4 KiB |                  25.7 |                    28.0 |               26.7 |
|     16 KiB |                  26.8 |                    28.2 |               24.5 |
|     64 KiB |                  39.6 |                    38.8 |               35.0 |
|    256 KiB |                  83.5 |                    84.1 |               77.1 |

- Net per write runs from 1.53 ms (`sql.exec`, 16 KiB) to 5.26 ms (unawaited, 256 KiB). The earlier notes round the range to 25 to 84 ms per request and 1.5 to 5.2 ms per write.
- The three shapes are close at every size. The largest ratio of the highest to the lowest median wall time is 1.083 at 1 KiB and 1.029 to 1.053 at the other four sizes, so "within about 5%" holds for four of five sizes and not for 1 KiB.
- The 1 KiB cells are slower than the 4 KiB cells in all three shapes. Nothing in the data explains it.
- Inside the object a `put` returns at once: 1,600 timed puts read 0 ms at most. The wait is at the response.
- The earlier notes read the cells as a fixed cost of about 25 ms plus about 14 ms per MiB written in a request, with 25.7 ms at 64 KiB written and 83.5 ms at 4 MiB. Those two cells are in the table. No model was fitted here, so the per-MiB figure is a two-point reading.

### Rung 2: hops

200 sequential no-op calls plus the first call, from an executor object to an owner object, three repeats per mode. n = 603 calls per mode, all in one colo (the colo probe returned the same colo on every row). `h1` rows pass `locationHint`.

| Mode               | Median ms | p90 ms | Min ms | Max ms |
| ------------------ | --------: | -----: | -----: | -----: |
| `fetch`            |        10 |     16 |      4 |     35 |
| `rpc`              |         7 |     10 |      3 |     52 |
| call to own stub   |         3 |      5 |      1 |     16 |
| local awaited call |         0 |      0 |      0 |      0 |
| `fetch`, `h1`      |        11 |     22 |      1 |     25 |
| `rpc`, `h1`        |        10 |     25 |      1 |     30 |

The first call of each series, recorded apart (n = 18 across modes), has a median of 18 ms and a maximum of 52 ms. A hint did not lower the hop. Every object was already in one colo, so the 55 ms offset between the two executors of the managed run did not reproduce.

### Rung 3: stub calls per invocation

Four shapes, two repeats each, all 8 client requests returned 200.

| Shape                      | Requested | Result                                                              |
| -------------------------- | --------: | ------------------------------------------------------------------- |
| sequential `fetch` stubs   |     1,000 | loop indices 0 to 998 succeeded, index 999 failed (both repeats)    |
| sequential RPC             |        33 | all succeeded                                                       |
| `Promise.all` of `fetch`   |        16 | all succeeded                                                       |
| `Promise.all` of RPC       |        16 | all succeeded                                                       |

The failure text is "Too many API requests by single Worker invocation". The series makes one first call before the loop, so 1,000 stub calls succeeded and the 1,001st failed. The earlier notes say 999 succeed and the 1,000th fails, which counts the loop only. The cap is 1,000 stub calls per invocation.

### Rung 4: CPU-bound requests

A loop of integer multiplies in a Durable Object, sized by a ladder of iteration counts, then at two wall-time targets.

| Run        | Requests | Returned 200 | Largest loop        | Longest wall |
| ---------- | -------: | -----------: | ------------------- | -----------: |
| `cpu-cap`  |       19 |           19 | 128,000,000 loops   |     2,225.9 ms |
| `ladder`   |       19 |           19 | 139,711,140 loops   |       876.1 ms |

No request was cut. The same loop count ran from 249 ms to 876 ms in the `ladder` run (the five 139,711,140-loop requests), so wall time varies by 3.5 times for identical work. This shows there is no 10 ms CPU cap for requests of this size. It does not measure billed CPU.

### Rung 5: colocated read-modify-write

One 64 KiB blob in a `Store` object, read and rewritten through `sql.exec`, 50 and 200 cycles per request, three repeats.

| Repeat | Slope, ms per cycle |
| -----: | ------------------: |
|      0 |               0.134 |
|      1 |               0.067 |
|      2 |               0.398 |

The slope is wall time of the 200-cycle request minus the 50-cycle request, over 150 cycles. A request that reads the blob 200 times (n = 3, 82 to 101 ms) cannot be told apart from a no-op request (n = 3, 66 to 109 ms).

### Rung 7: platform meter against linear memory

A Durable Object allocates a `WebAssembly.Memory` of 64 or 128 MiB, either writes one byte per 4 KiB page or touches nothing, and holds for 75 s. One class per instance, so each meter row belongs to one instance. Value is the class's largest meter sample.

| Linear memory | Arm       | Planned | Measured | Meter reading |
| ------------: | --------- | ------: | -------: | ------------: |
|        64 MiB | written   |       6 |        5 |      65.5 MiB |
|        64 MiB | untouched |       6 |        5 |      65.5 MiB |
|       128 MiB | written   |       6 |        5 |     129.5 MiB |
|       128 MiB | untouched |       6 |        4 |     129.5 MiB |
|        bare   | none      |       2 |        0 |          none |

Every measured cell reads the same value, so the slope is 1.00 MiB per MiB with an offset of 1.5 MiB, and the written and untouched arms do not differ. No class reported an exceeded-memory error. The unmeasured cells are the six classes past the first 20 of the account's namespace listing (`M20` to `M25`), which the run did not read, and one bare class (`M00`) that was listed and published no row. The second bare class was one of the six unlisted. See [METHOD](METHOD.md).

## Prediction misses

Predictions were written before each run. The full scoring is in [METHOD](METHOD.md). The misses:

- Rung 1: an awaited `put` at about 20 ms, with an unawaited batch at about one flush. Measured 1.6 to 5.2 ms per awaited write and an unawaited batch equal to the awaited one.
- Rung 2: a call to the object's own stub under 1 ms. Measured 3 ms.
- Rung 3: every one of the 1,000 sequential calls succeeds. The cap fell after 1,000.
- Rung 6 (see [spill-memory](../spill-memory/README.md)): the meter within 24 MiB of the idle control. It rose 34.5 MiB.
- Rung 7: about 0.8 MiB per MiB untouched. Measured 1.00.

## Reproduction

From the repository root, with Node 26:

```sh
node scripts/research/elastic-limits-summary.ts results/execution/platform-ladder
node experiments/elastic-limits/analyze.ts results/execution/platform-ladder/ladder
node experiments/elastic-limits/analyze.ts results/execution/platform-ladder/memory
node scripts/research/evidence.ts
```

The first command regenerates `summary.json` when it is missing and compares it when present. A live rerun deploys to the account and is described in [METHOD](METHOD.md).

## Artifacts

- `summary.json`: every table above with its n, generated from the raw files.
- `cpu-cap/`, `spill-pilot/`, `ladder/`, `memory/`: per run `raw.jsonl`, `meter.json`, `counters.json`, `budget.json`, `cleanup.json`, `source.json` and `namespaces.json` (absent for `cpu-cap`, which predates it).
- `redaction.json`: original size and SHA-256 of each redacted file.
- `source/ladder/`: the harness files of the version that produced `ladder` and `memory`.
- `manifest.json`: bytes and SHA-256 of every file here.

## Scope

- One Free account, one colo, one day. Repeats are 20 for rung 1, 3 for rungs 2 and 5, 2 for rung 3 and 6 per cell for rung 7.
- Wall times are client wall times. They include the front Worker and the network from one machine.
- The meter is a per-minute sample per class, and it lags the run by minutes. A reading is a lower bound on the instance's peak.
- Nothing here measures a paid plan, a different colo or a different day.
