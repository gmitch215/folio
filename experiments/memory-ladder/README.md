# Memory Ladder

Which allocations count toward the memory limit that resets a Durable Object with "exceeded its
memory limit", and does a dropped allocation still count until a collection?

## Arms

| Kind   | Allocation                                                                                                     | Touch                     |
| ------ | -------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `ab`   | `new ArrayBuffer(N MiB)`                                                                                       | one byte every 4096 bytes |
| `wasm` | `new WebAssembly.Memory({ initial: N * 16 })` (64 KiB pages)                                                   | one byte every 4096 bytes |
| `str`  | a string of N MiB built by concatenating 1 MiB chunks, then flattened                                          | not applicable            |
| `swap` | an N MiB `ArrayBuffer` is dropped, the driver waits `delay` ms, then a second N MiB `ArrayBuffer` is allocated | always touched            |

Each ladder sample uses a fresh Durable Object name and sends two requests. The first allocates. The
second is a `free` request that releases everything the object holds and returns the instance id.
A changed instance id between the two means the object restarted. The allocation failure is not
caught inside the object, so a reset reaches the caller as an error.

## Files

| File             | Role                                               |
| ---------------- | -------------------------------------------------- |
| `worker.mjs`     | the `Ladder` Durable Object and the Worker entry   |
| `wrangler.jsonc` | one SQLite-backed class, `Ladder`, bound as `L`    |
| `ladder.ts`      | the typed driver; writes `runs/ladder-<time>.json` |

## Running

The driver needs the Worker origin in `WORKER_URL`. It prints the origin nowhere.

```sh
npx wrangler deploy --config experiments/memory-ladder/wrangler.jsonc
WORKER_URL=$WORKER_URL node experiments/memory-ladder/ladder.ts
npx wrangler delete --config experiments/memory-ladder/wrangler.jsonc
```

The driver reads these optional variables: `KINDS` (default `ab,wasm,str`), `RUNGS` (default
`96,128,160,176,192,208,224,256`), `SAMPLES` (default `6`), `SWAP` (set `0` to skip the swap part),
`SWAP_MIBS` (default `64,96,112`), `SWAP_DELAYS` (default `0,5000,30000`), and `OUT` (default
`experiments/memory-ladder/runs`).

A full run sends about 400 requests. The swap part holds requests open for up to 30 seconds. The run
recorded below took 13 minutes.

Setting `ARMS` to a comma list of `ceiling`, `chunks-ab`, `chunks-wasm`, `chunks-mixed`,
`two-instances` and `touch` runs the cumulative arms instead, and skips the rung ladder and the swap
part. `REQUEST_TIMEOUT_MS` (default `90000`) aborts a request that does not return, and the sample
records it as an other failure.

## Results

### Rung Ladder

One full run on one deployment, 2026-11-22, starting 03:29 UTC. Each cell is six samples, written
as ok / memory resets / other failures. No sample reached a memory reset.

| Rung (MiB) | `ab`      | `wasm`    | `str`     |
| ---------: | --------- | --------- | --------- |
|         96 | 6 / 0 / 0 | 6 / 0 / 0 | 6 / 0 / 0 |
|        128 | 6 / 0 / 0 | 6 / 0 / 0 | 6 / 0 / 0 |
|        160 | 0 / 0 / 6 | 0 / 0 / 6 | 0 / 0 / 6 |
|        176 | 0 / 0 / 6 | 0 / 0 / 6 | 0 / 0 / 6 |
|        192 | 0 / 0 / 6 | 0 / 0 / 6 | 0 / 0 / 6 |
|        208 | 0 / 0 / 6 | 0 / 0 / 6 | 0 / 0 / 6 |
|        224 | 0 / 0 / 6 | 0 / 0 / 6 | 0 / 0 / 6 |
|        256 | 0 / 0 / 6 | 0 / 0 / 6 | 0 / 0 / 6 |

The smallest rung where more than half the samples reset is none, for all three kinds.

The failures at 160 MiB and above were allocation errors:

- `ab`: `Invalid array buffer length`
- `wasm`: `WebAssembly.Memory(): could not allocate memory`
- `str`: `RangeError`

The swap part allocated and dropped an `ArrayBuffer` and then allocated a second one. Every cell
was 6 / 0 / 0:

| MiB | Delay 0 ms | Delay 5000 ms | Delay 30000 ms |
| --: | ---------- | ------------- | -------------- |
|  64 | 6 / 0 / 0  | 6 / 0 / 0     | 6 / 0 / 0      |
|  96 | 6 / 0 / 0  | 6 / 0 / 0     | 6 / 0 / 0      |
| 112 | 6 / 0 / 0  | 6 / 0 / 0     | 6 / 0 / 0      |

The run shows that all three allocation kinds succeed up to 128 MiB, and that a dropped
`ArrayBuffer` does not block a second 112 MiB allocation after waits of up to 30 seconds. Every
allocation from 160 MiB up failed inside the runtime, before any reset. The second request also
never returned a different instance id, so no object restarted during the run.

The run does not show whether `WebAssembly.Memory` counts toward the memory limit the same way an
`ArrayBuffer` does. The allocation failures came first, so the limit that resets an object was not
reached. It also does not show whether a dropped allocation still counts after a collection, the
reset threshold, or what sets the allocation ceilings between 128 and 160 MiB. Those need a finer
rung set between 128 and 160 MiB, or a different kind of allocation that the runtime accepts above
that range.

### Cumulative Arms

Each sample uses a fresh object. The object first runs a burn of 6.6 to 11 seconds of CPU before the measured events. Then a `free` request records the instance
id, the allocation events run, and a second `free` request records the instance id again. Nothing
is released between the allocation events, so the allocations add up. Six samples per cell.

| Arm                                                        | Kind         | Cells | Result                                                 |
| ---------------------------------------------------------- | ------------ | ----: | ------------------------------------------------------ |
| Single block, 130 to 159 MiB, touched and untouched        | `ab`, `wasm` |    20 | refused, 6 of 6 per cell, no reset, no instance change |
| 32 MiB chunks, K = 3 to 7 (96 to 224 MiB held)             | `ab`, `wasm` |    10 | ok, 6 of 6 per cell                                    |
| 32 MiB chunks, K = 8 (256 MiB held)                        | `ab`, `wasm` |     2 | memory-limit reset, 6 of 6 per cell                    |
| 64 MiB `ab` plus K 32 MiB `wasm`, K = 2 to 5               | `mixed`      |     4 | ok, 6 of 6 per cell                                    |
| Two 96 MiB `wasm`, drop both, then 96 MiB, delay 0 to 30 s | `wasm`       |     3 | ok, 6 of 6 per cell                                    |
| Touched 32 MiB chunks, K = 6 (192 MiB held)                | `ab`, `wasm` |     2 | ok, 6 of 6 per cell                                    |

Single-block allocations reached the same ceiling for both kinds. Touched 128 MiB was ok in the rung
run, and touched 130 MiB was refused for both kinds, so the edge lies between 128 and 130 MiB. Untouched
128 MiB was not run in the cumulative arms.

Split into 32 MiB chunks, `ab`, `wasm` and mixed allocations all held 224 MiB without a reset. The
memory-limit reset appeared at 256 MiB held, on every sample of both chunked arms. The reset error
text was "Durable Object's isolate exceeded its memory limit and was reset."

The instance id changed on every sample at 192 MiB held or more: chunks K = 6 and 7, mixed K = 4 and
5, the two-instances arm, and touched K = 6. Those samples returned ok. Below 192 MiB held,
no sample changed instance. The run does not show the cause of these instance changes.

After 192 MiB was held and then dropped, a 96 MiB allocation succeeded at delay 0, 5 and 30 seconds.
If the dropped charge still counted, the total would have been 288 MiB, above the 256 MiB that reset
the chunked arms. The dropped charge was therefore not counted at delay 0 ms, and the run does not
show a delay at which it would come back.

The run does not show a reset threshold between 224 and 256 MiB, whether the untouched and touched
arms reset at the same total, or whether the instance changes at 192 MiB and above are the same
mechanism as the reset at 256 MiB. It also has no CPU limit or storage reset.

## Limits

- One account, one day, one deployment. Each sample is a fresh object, so object reuse is not tested.
- The driver classifies a failure as a memory reset only when the error text contains "memory limit".
  Other failure texts are recorded as they arrive.
- The `ab` ladder can stop at a V8 array buffer length limit before the memory limit is reached.
  The 256 MiB pilot on `ab` failed with `Invalid array buffer length`, which is an allocation error,
  not a reset.
- Platform reset text and thresholds are not published. The results describe behavior observed on
  this deployment only.
