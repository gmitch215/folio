# Memory Accounting

A Durable Object is reset when it exceeds a memory limit, and the number that decides the reset is not the documented one. This page covers what the platform meter counts, how an object's own storage writes show up in it, and the guards Folio built around a guest's linear memory.

## Question

Which allocations count toward the memory limit that resets a Durable Object, how does the meter charge linear memory, and what can a host do to keep a guest under the line?

## Instruments

| Instrument                                                                                                    | What it measures                                                             | Where                            |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------- |
| [memory-ladder](https://github.com/gmitch215/folio/blob/master/experiments/memory-ladder/README.md)           | allocation kinds, cumulative holds and whether a dropped buffer still counts | bare objects, paid plan          |
| [platform-ladder](https://github.com/gmitch215/folio/blob/master/results/execution/platform-ladder/README.md) | the meter against a `WebAssembly.Memory` of 64 and 128 MiB                   | Free plan                        |
| [spill-memory](https://github.com/gmitch215/folio/blob/master/results/execution/spill-memory/README.md)       | the meter against bytes written to an object's own storage                   | Free plan                        |
| [growth-governor](https://github.com/gmitch215/folio/blob/master/experiments/growth-governor/README.md)       | a cap on `memory.grow` under an Emscripten PHP guest                         | Node 22 and the PHP module       |
| the Drupal host probes, in [the report](../../TECHNICAL_REPORT.md#a-drupal-distribution-on-durable-objects)   | idle charge, retained buffers, boot garbage, stack shrink                    | local workerd and a Paid account |

The platform meter is the account's GraphQL dataset `durableObjectsPeriodicGroups`, field `max { memoryUsageBytes }`, per class and minute. Every figure is one account, one deployment and one day unless it says more. The Drupal host figures come from deploys whose raw rows are not all exported to `results/`.

## Design

The memory ladder sends each sample to a fresh object with two requests. The first allocates, and the second releases everything and returns the instance id, so a changed id means the object restarted. The allocation failure is not caught inside the object, so a reset reaches the caller as an error. The arms are an `ArrayBuffer`, a `WebAssembly.Memory` and a built string at each rung, a swap arm that drops a buffer, waits and allocates a second, and cumulative arms that hold many chunks without releasing.

## Results

### What the Ladder Showed

| Rung (MiB) | `ArrayBuffer`  | `WebAssembly.Memory` | String         |
| ---------: | -------------- | -------------------- | -------------- |
|         96 | 6 ok           | 6 ok                 | 6 ok           |
|        128 | 6 ok           | 6 ok                 | 6 ok           |
| 160 to 256 | 6 of 6 refused | 6 of 6 refused       | 6 of 6 refused |

Each cell is six samples. No sample reached a memory reset in the rung ladder. The failures at 160 MiB and above were allocation errors inside the runtime: `Invalid array buffer length`, `WebAssembly.Memory(): could not allocate memory` and `RangeError`. Touched 128 MiB was ok and touched 130 MiB was refused for both buffer and memory, so the single-block edge lies between 128 and 130 MiB.

The cumulative arms hold chunks of 32 MiB and add up:

| Arm                                                   | Held           | Result                              |
| ----------------------------------------------------- | -------------- | ----------------------------------- |
| 32 MiB chunks, `ArrayBuffer` and `WebAssembly.Memory` | 96 to 224 MiB  | ok, 6 of 6 per cell                 |
| 64 MiB buffer plus 32 MiB memories                    | 128 to 224 MiB | ok, 6 of 6 per cell                 |
| 32 MiB chunks                                         | 256 MiB        | memory-limit reset, 6 of 6 per cell |
| Touched 32 MiB chunks                                 | 192 MiB        | ok, 6 of 6 per cell                 |

The reset error text was "Durable Object's isolate exceeded its memory limit and was reset." The instance id changed on every sample at 192 MiB held or more, with those samples returning ok, and no sample changed instance below 192 MiB. The run does not show the cause of those instance changes.

A dropped buffer does not keep counting. After 192 MiB was held and then dropped, a 96 MiB allocation succeeded at delays of 0, 5 and 30 seconds. If the dropped charge still counted, the total would have been 288 MiB, above the 256 MiB that reset the chunked arms. A swap of an `ArrayBuffer` of 64, 96 or 112 MiB at those delays was ok in all 54 samples.

### How the Meter Charges Linear Memory

A Durable Object allocated a `WebAssembly.Memory` of 64 or 128 MiB, wrote one byte per 4 KiB page or touched nothing, and held for 75 s.

| Linear memory | Arm       | Meter reading |
| ------------: | --------- | ------------: |
|        64 MiB | written   |      65.5 MiB |
|        64 MiB | untouched |      65.5 MiB |
|       128 MiB | written   |     129.5 MiB |
|       128 MiB | untouched |     129.5 MiB |

The slope is 1.00 MiB per MiB with an offset of 1.5 MiB, and written and untouched pages do not differ. A touched page and a reserved page cost the same.

### What Storage Writes Cost the Meter

Writing to an object's own storage raises the meter on the writing object, and the rise follows the row size.

| Spilled | Row size | Meter rise (MiB) |         n |
| ------: | -------- | ---------------: | --------: |
|  64 MiB | 1 MiB    |             34.5 | 6 per arm |
|  16 MiB | 4 KiB    |   1.875 to 1.945 |         3 |
|  16 MiB | 6 KiB    |           16.496 |         1 |
|  16 MiB | 8 KiB    |            16.25 |         2 |
|  16 MiB | 16 KiB   |            16.25 |         1 |
|  16 MiB | 64 KiB   |             16.0 |         1 |
| 128 MiB | 1 MiB    |             32.5 |         3 |
| 256 MiB | 1 MiB    |             28.5 |         3 |

The meter holds up to a ceiling near 36 MiB for the writing object, on the writing object and not on its caller. Rows of 6 KiB or more hold everything written up to the ceiling, and rows of 4 KiB hold much less. The held memory does not decay while the object keeps receiving requests, and every reading taken five minutes or more after a spill was 0.0. Deleting the storage did not release the memory in two of three repeats. The curve against spill size is not proportional and not a clean plateau: 32 MiB read 2.5 MiB in all three repeats, for a cause that is unknown. Most cells have one to three repeats. A dedicated owner object absorbs the memory at the price of a stub call per spill step.

### The Drupal Host

On the Paid account an idle instantiated PHP module reads linear memory plus 9.02 MiB on the meter, against 1.51 MiB for an empty module. The 7.5 MiB difference does not move when the module loses 30 percent of its function bytes, 60 percent or its 3.7 MB of data bytes (spread 0.00 across six deploys), and the slope is 1.000 per MiB of touched memory. At most 6 to 10 percent of the 72.6 to 125.3 MiB idle offset of the Thunder host is the idle instance.

On local workerd a booted Thunder isolate retains 59 to 71 MiB outside the wasm linear memory after a full collection: compiled-code state 18.5 to 19.4, JS heap 20 to 30, the pack blob 12.4, other buffers 6 to 7 and the pack index 1.3. The buffers the plan named as suspects (boot image, database image, heap-store buffers) were 0.

One boot allocates about 1 GiB of short-lived strings, 285 MiB in the installed-module mount and 235 MiB in the lazy pack mount, because path creation has no directory cache in the per-row loop. Locally, a directory cache cut boot allocation from 998.5 to 776.6 MiB (one run each) and did not lower the heap high-water mark. Deployed, the patch showed no meter effect: peaks of 249 and 250 MiB against 241 and 245 for the control.

On a bare Durable Object the meter tracks live heap and not committed heap, at n = 1 per variant. A 40 MiB live set reads 44.16 MiB. The same set after 1 GiB of string churn reads 58.97 MiB for the first two to three minutes and 42.16 MiB from the fourth minute, while the same churn leaves 106.9 MiB committed against 43.7 used locally. A 150 MiB synchronous burst never showed in the meter.

### Stack Shrink

Rewritten modules with a 4 MiB stack end 28.0 MiB lower in touched memory (from the run notes, not recounted). A finite `array_map` recursion of 2,647 to 2,656 levels returned the right answer with the stack overrun and static data below the stack end changed, in 5 of 5 runs, so a native stack that guards 4 MiB is refuted. A stack-limit check pass inserts a check before every stack-pointer lowering (12,977 checks, module size +1.30 percent) and turns the silent cases into clean traps with static data unchanged: about 950 harness runs at the default and 62 MB native stacks, 0 silent and 0 hangs. On the quiet rig, 340 interleaved pairs per arm over four routes, the guarded module over the unguarded module has a median of 1.000 to 1.013 with an interval top of 1.021. A guard trap loses the request, and writes through bad pointers into static data are not covered.

With one deploy per arm the savings on the platform were 17.9 MiB (4 MiB stack) and 33.3 MiB (4 MiB plus 256 import pages) for cold admin, against 27.7 predicted. Spread between arms exceeded the effect, and all three arms were killed above the line, with meter peaks of 222 to 248 MiB. A repeat with two or three deploys per arm counted reset markers on cold admin of 2 of 2 (control), 1 of 3 (guarded 4 MiB) and 0 of 3 (guarded 4 MiB with 256 pages). Every arm crossed 203 MiB on the meter, the guard never fired, and the intervals overlap in every row, so the effect is neither shown nor refuted.

### The Growth Governor

`governGrowth` in `@gmitch215/folio/memory` wraps the `grow` method of one `WebAssembly.Memory` and refuses any grow whose final size would pass a byte cap. The cap has to sit on `grow`. The Emscripten glue tries the current size times 1.2, 1.1 and 1.05, never below the request, and a cap on the requested size let a 107,548,672-byte request take linear memory to 115.25 MiB under a 104 MiB cap. The experiment boots a PHP 8.5 interpreter with `memory_limit=96M` and runs a 64 MiB string allocation.

| Arm               | Cap     | Refusals           | PHP output              | Final memory (bytes) | Outcome                                  |
| ----------------- | ------- | ------------------ | ----------------------- | -------------------: | ---------------------------------------- |
| `open`            | none    | 0                  | none                    |          120,848,384 | completes; sha256 matches                |
| `capped`          | 104 MiB | 2                  | none                    |          107,610,112 | completes on the third attempt           |
| `capped-trycatch` | 104 MiB | 2                  | `completed`             |          107,610,112 | completes; the `catch` block never runs  |
| `capped-fit`      | 160 MiB | 0                  | none                    |          120,848,384 | completes; sha256 matches                |
| `capped`          | 100 MiB | 6, two per attempt | `[error] Out of memory` |          100,663,296 | `_run` throws `ExitStatus` with status 1 |

With the 100 MiB cap, PHP's own `catch` never ran, the memory stayed at its 96 MiB boot size, and shutdown, startup and `1+1` still worked. Every run repeated byte for byte ([growth-governor](https://github.com/gmitch215/folio/blob/master/experiments/growth-governor/README.md)). The governor guards linear memory only. It turns a platform memory reset into a failed request and does not bound the JS-side charge.

### The Platform Line

The measured kill line of the Drupal host is about 203 MiB on the platform meter, and the documented 128 MB sizes nothing there. On the Free plan a Durable Object isolate was not reset at 128 MB: with the unmodified module and 64 MiB of memory it held 216 MiB of live memory and buffers before a reset, and with 1,322 pages 194.6 MiB (n=3 objects each, one 8 MiB step per request). The larger memory cost 40 MiB of headroom for 18.6 MiB of added memory, and the cause of the factor of 2.1 is not determined. The two numbers are not reconciled, and the platform meter reading is the measured one.

## Reading

The meter charges a reserved page as much as a touched one, counts live heap and not committed heap, and holds storage writes on the writing object for minutes. A dropped buffer does not keep counting. Single allocations stop near 128 MiB, and chunked holds reach 224 MiB before a reset. The governor turns an oversized `memory.grow` into a failed request with the memory unchanged, which is the guard a paged design needs. The cap for a given build is not measured: the request-reuse arm of one earlier build held 113.9 MiB after its full workload, which a 112 MiB cap would refuse.

## Closed and Open

Closed: the idle module charge, retained buffers, boot garbage with a directory cache, and committed heap as the meter's basis.

Open: whether `WebAssembly.Memory` counts toward the reset limit the same way as an `ArrayBuffer` (the allocation failures came first), the reset threshold between 224 and 256 MiB, what sets the allocation ceilings between 128 and 160 MiB, whether the instance changes at 192 MiB held share a mechanism with the reset at 256 MiB, whether the guarded stack shrink lowers the kill rate on the platform, and the memory fit of the translated module on Workers. No deployed fix completes the failing Thunder routes.

## See Also

- Report: [A Drupal Distribution on Durable Objects](../../TECHNICAL_REPORT.md#a-drupal-distribution-on-durable-objects), [Storage Resets and the Growth Governor](../../TECHNICAL_REPORT.md#storage-resets-and-the-growth-governor)
- Module: [Memory](../modules/memory.md)
- Related studies: [Elastic Memory](elastic-memory.md), [Storage Resets](storage-resets.md)
