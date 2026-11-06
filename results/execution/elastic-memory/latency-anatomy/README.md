# Latency Anatomy

Question: where do the 392 s of the managed run go?

One run, two equations, hypotheses. The split below is derived from the per-request wall times of the [managed run](../managed-envelope/README.md). It is not measured per term, so each term is a hypothesis for E1 to test.

## Derived split

Write-phase requests (576, each with 16 awaited 64 KiB puts): mean 533 ms, 33.3 ms per operation. Read-phase requests (385, with 8 storage gets and 8 owner-cache hits each): mean 221.5 ms, 13.8 ms per operation. The write-minus-read gap is about 307 ms per request, which puts an awaited put at about 19 to 20 ms.

| Term                                   | Count  | Cost each        | Time          | Share     | Hypothesis |
| -------------------------------------- | -----: | ---------------- | ------------- | --------- | ---------- |
| Awaited 64 KiB put                     |  9,216 | about 19.5 ms    | about 180 s   | 46%       | H2         |
| Executor to owner hop                  | 15,360 | 9 to 10.6 ms     | 138 to 163 s  | 35 to 42% | H1         |
| Top-level request                      |    961 | 40 to 55 ms      | 38 to 53 s    | 10 to 13% | H3, H4     |
| Owner storage get                      |  3,072 | at most 0.3 ms   | about 1 s     | under 1%  |            |
| Wasm, Asyncify and JSON                | 15,360 | role CPU 17.8 s  |               | about 4%  |            |

Hypotheses:

- H1: the executor-to-owner hop (about 9 to 10.6 ms) is the second-largest cost.
- H2: the awaited whole-page put is the largest cost. It is a per-write cost, not a per-byte cost. A synchronous write behind one output gate may cost far less.
- H3: placement. Executor object 0 is a constant 55 ms slower than object 1 in both phases, which points at where the objects sit.
- H4: 16 operations per request came from a belief that 50 subrequests is the limit. Free allows 1,000 internal subrequests per invocation, so the 961 requests and their 48 s may fall away.
- H5: an executor that owns its pages and keeps a frame cache removes the hop from almost every operation.

The terms sum to 357 to 397 s against the measured 392 s.

## Model

`scripts/research/elastic-model.ts` simulates the fixture trace under named variants. It is a model, not a measurement, and its costs are parameters.

- It reproduces the request count (961, with a terminal request after the last operation lands on a boundary) and the write-phase mean within 1.2%.
- The hop cost in the defaults is 10.6 ms. That value is a single-parameter refit to the read phase of this run. The calibration in `model.json` is therefore not independent of the run it calibrates.
- The write phase lands at +1.2%, not within 1% as an earlier note said. The refit and the test tolerance are both recorded in `scripts/research/elastic-model.ts` and `tests/unit/elastic-model.test.ts`.
- The variant totals in the earlier R1 table were computed with a hop of 9 ms. Under the refit they move (for example, the frames-4 variant goes from 165.7 s to 175.5 s), so `model.json` supersedes that table.

Named-variant totals at the refit defaults are in `model.json`. The colocated rows use the remote put cost, 20 ms, because no local put was measured. Read them as "if a local put cost 20 ms".

## Scope

- One run. No hop, put or placement term was measured on its own.
- The model does not show a local put or get cost, because none was measured.
- Placement and the colocated design are open until E1 and E2 run.
