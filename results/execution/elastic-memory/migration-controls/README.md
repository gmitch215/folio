# Migration Controls

Question: when an executor is interrupted at a 512 MiB logical heap with four active pages, how many pages does each migration control move, and what does a receiver that touches only some of those pages pay? A second question: how does the executor's frame eviction policy change the number of page fetches as the frame count grows?

## Inputs

- The 512 MiB heap is the pointer walk used in [capacity-local](../capacity-local/README.md). Four pages are touched before handoff. The receiver touches 1, 2 or 4 of those four after handoff.
- The frame sweep runs a 3,072-page (192 MiB) trace on three patterns: a dense chain, a skewed Zipf trace with 70% loads, and a sequential scan. Each pattern runs at 4 to 256 frames under round-robin and LRU eviction.
- Predictions are in [predictions.json](predictions.json), written before the touched-receiver run. The frame sweep predictions come from the trace-driven model in [elastic-model.ts](../../../../scripts/research/elastic-model.ts) and are in [sweep-predictions.json](sweep-predictions.json), written before the sweep ran.

## Instrument

`scripts/probe/elastic/run.ts` runs the touched-receiver matrix (`FOLIO_ELASTIC_MATRIX=touched`). `scripts/probe/elastic/sweep.ts` runs the trace-driven frame sweep. `scripts/probe/elastic/access.ts` holds the touch schedule, the trace generators, the LRU victim rule and the stack-distance and checksum helpers. `scripts/research/elastic-controls.mjs` compares the touched rows with the predictions and with the capacity-local rows, and writes `summary.json`.

## Controls

- **Eager.** Restores and copies the full logical allocation at handoff.
- **Post-copy.** Allocates the full logical memory and fetches pages on demand after handoff.
- **Profile prefetch.** Post-copy with a known working-set profile. The receiver fetches the profile at resume, whatever it then touches.
- **Elastic.** Four physical frames carried in the checkpoint with their contents.
- **Elastic, lazy restore.** Carries only the control page, so the frame contents do not travel. Every frame refetches on first touch.

These are mechanisms, not published systems. The names describe what each arm does.

## Results

Payload per control at 512 MiB, four pages before handoff. Pages are 65,536 bytes. Totals include the checkpoint image and every fetch, from both segments.

| Control | Receiver touches | Fetched pages | Checkpoint pages | Total pages | Total bytes | Predicted pages | Match |
| ------- | ---------------: | ------------: | ---------------: | ----------: | ----------: | --------------: | ----- |
| Eager | 1, 2 or 4 | 8,192 | 8,193 | 16,385 | 1,073,807,360 | 16,385 | yes |
| Post-copy | 1 | 5 | 1 | 6 | 393,216 | 6 | yes |
| Post-copy | 2 | 6 | 1 | 7 | 458,752 | 7 | yes |
| Post-copy | 4 | 8 | 1 | 9 | 589,824 | 9 | yes |
| Profile prefetch | 1 | 8 | 1 | 9 | 589,824 | 6 | no |
| Profile prefetch | 2 | 8 | 1 | 9 | 589,824 | 7 | no |
| Profile prefetch | 4 | 8 | 1 | 9 | 589,824 | 9 | yes |
| Elastic | 1, 2 or 4 | 4 | 5 | 9 | 589,824 | 9 | yes |
| Elastic, lazy | 1 | 5 | 1 | 6 | 393,216 | 6 | yes |
| Elastic, lazy | 2 | 6 | 1 | 7 | 458,752 | 7 | yes |
| Elastic, lazy | 4 | 8 | 1 | 9 | 589,824 | 9 | yes |

Direction columns, from `summary.json`. "To receiver" is the checkpoint plus the pages the receiving segment fetched. "From receiver" is the receiving segment's writeback, which is zero on these read-only traces.

| Control | Receiver touches | Source fetch | Checkpoint | Receiver fetch | To receiver |
| ------- | ---------------: | -----------: | ---------: | -------------: | ----------: |
| Eager | any | 536,870,912 | 536,936,448 | 0 | 536,936,448 |
| Post-copy | 1 / 2 / 4 | 262,144 | 65,536 | 65,536 / 131,072 / 262,144 | 131,072 / 196,608 / 327,680 |
| Profile prefetch | 1 / 2 / 4 | 262,144 | 65,536 | 262,144 | 327,680 |
| Elastic | 1 / 2 / 4 | 262,144 | 327,680 | 0 | 327,680 |
| Elastic, lazy | 1 / 2 / 4 | 262,144 | 65,536 | 65,536 / 131,072 / 262,144 | 131,072 / 196,608 / 327,680 |

Every row decodes to the expected value (`exact`), and the four t = 4 rows for eager, post-copy, prefetch and elastic equal the capacity-local rows in payload, checkpoint and fetch bytes.

### Identity

Post-copy moves (4 + t + 1) pages and elastic moves (4 + 5) pages. The two are equal only at t = 4. The elastic total does not depend on t, because the four frames travel in the checkpoint whether or not the receiver uses them.

Profile prefetch does not follow the post-copy identity. Its receiver preloads the whole four-page profile at every resume, so it moves nine pages at each t. Its two prediction misses (t = 1 and t = 2) come from this.

Elastic, lazy restore moves the same pages as post-copy at each t, and holds at most four frames plus the control page in the receiver. The bytes do not change; the resident memory does.

## Frame Sweep

Predicted values are the LRU counts from the model. Measured values are from the executor. Each cell is one trace at one frame count. Fetches are misses that read a page from backing storage. Writebacks include the final flush.

| Trace | Frames | LRU fetches | LRU writebacks | Round-robin fetches | Round-robin writebacks |
| ----- | -----: | ----------: | -------------: | ------------------: | ---------------------: |
| Dense chain | 4 to 128 | 3,072 | 3,072 | 3,072 | 3,072 |
| Dense chain | 256 | 3,067 | 3,072 | 3,067 | 3,072 |
| Skewed (Zipf 1.1, 70% loads) | 4 | 17,243 | 5,608 | 17,528 | 5,703 |
| Skewed | 8 | 15,443 | 5,212 | 16,094 | 5,483 |
| Skewed | 16 | 13,332 | 4,563 | 14,327 | 5,158 |
| Skewed | 32 | 11,245 | 3,879 | 12,392 | 4,663 |
| Skewed | 64 | 9,274 | 3,232 | 10,400 | 4,044 |
| Skewed | 128 | 7,538 | 2,701 | 8,563 | 3,451 |
| Skewed | 256 | 5,885 | 2,166 | 6,766 | 2,841 |
| Sequential scan (two passes) | 4 to 256 | 6,144 | 0 | 6,144 | 0 |

All 42 sweep rows decode to the expected value. LRU matches the model in fetches, writebacks and stack-distance misses in every cell.

### Model Check

The model in `elastic-model.ts` claims that the dense chain is cache-proof between 4 and 256 frames. The measurement agrees for 4 to 128 frames: each page is fetched once and written back once. At 256 frames, five loads hit and the fetch count is 3,067, not 3,072. The model predicts the same 3,067 at 256, so the earlier hand check, which said 4, 64 and 256 frames give the same gets, was wrong at 256. The model's simulated total differs by 55 ms (0.03%) between 128 and 256 frames. The claim holds to within five fetches of 3,072.

The dense chain has reuse distances from 0 to 3,071 pages. The five hits at 256 frames come from distances between 1 and 255.

### Eviction Policy

Round-robin evicts in load order (FIFO), not by recency. It matches LRU on the dense chain and the scan. On the skewed trace it fetches more pages at every frame count: 1.7% more at 4 frames and 15.0% more at 256. The gap grows with the frame count because LRU keeps the hot pages resident and round-robin does not.

The 512 MiB controls use four working pages with four frames. Those rows never evict, so round-robin and LRU give identical counts there by construction. The LRU arm is therefore the frame sweep above, not a separate row in the touched matrix.

## Scope

- Counts are local, one machine, Node workers and a file-backed backing store. Timings in `touched-raw.json` and `sweep-raw.json` are not reported as latency.
- The payload counts exclude protocol overhead and storage amplification.
- The sweep backing is a synthetic word per page in a real file. It measures fetch and writeback counts, not I/O cost.
- The controls are mechanisms. They say nothing about any published system.
- The touched-receiver matrix sets `directory` to a placeholder in its output. The capacity-local files were redacted by hand; see [METHOD](METHOD.md).
