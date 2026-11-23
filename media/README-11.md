# Range Lanes

Question: does a managed pool that ships learned byte ranges to lane objects beat a full snapshot copy, and does it beat serial execution as the kernel grows?

## Method

`ManagedFolio` runs a partitioned kernel (`main(base, waves, rounds)`: four 16 KiB partitions per wave, each in its own call, `rounds` of an integer mixing step per word) over four lanes. The owner holds the canonical memory and ships the byte ranges a footprint cache learned. A lane runs the tracked module on a private memory that is zero outside the shipped ranges and returns its reads, writes and any read outside what was shipped. The owner recomputes escapes from the returned read set, widens the footprint and retries up to three rounds, then falls back to a snapshot or to serial. The kernel is run at 1,024, 4,096, 16,384 and 65,536 rounds.

Arms per arena (128 KiB to 32 MiB, zero and random fill): `snapshot` (a full memory copy per lane call), `ranges-cold`, `ranges-warm` (a reused pool with a learned footprint) and `serial` on the owner. Three measured rounds after two warmups. Lanes are four service-bound Workers or four Durable Object instances (`FOLIO_RANGES_LANES=do`). All runs are on a paid account, deployed, measured and deleted.

## Results at 8 MiB

Median client wall in ms, zero and random fill; the last column is serial over `ranges-warm`.

| Record | Lanes | Rounds | Serial | Ranges warm | Serial over warm |
| --- | --- | --- | --- | --- | --- |
| `service-1024` | Workers | 1,024 | 136 / 134 | 231 / 236 | 0.59 / 0.57 |
| `service-4096` | Workers | 4,096 | 428 / 434 | 428 / 363 | 1.00 / 1.20 |
| `service-16384` | Workers | 16,384 | 1,675 / 1,691 | 1,211 / 1,213 | 1.38 / 1.39 |
| `object-16384` | Durable Objects | 16,384 | 1,830 / 1,762 | 1,144 / 1,066 | 1.60 / 1.65 |
| `object-65536-default-fuel` | Durable Objects | 65,536 | 6,936 / 7,592 | 8,269 / 8,444 | 0.84 / 0.90 |
| `object-65536-raised-fuel` | Durable Objects | 65,536 | 7,294 / 7,403 | 3,694 / 3,710 | 1.98 / 2.00 |

- Every returned sample was exact: the digest of the final memory equalled the serial run's. Ranges shipped about 0.1% to 0.2% of the snapshot's bytes at 8 MiB, and a 32 MiB arena ran in ranges mode where snapshot mode cannot send it.
- `ranges-warm` took 0.36 to 0.79 of the snapshot arm's wall at 8 MiB.
- Service-bound Workers do not overlap CPU work ([lane-concurrency](../lane-concurrency/README.md)); Durable Object lanes do. That is the difference between the Worker rows and the first Durable Object row.
- `object-65536-default-fuel`: the speculative fuel default (100,000,000 back-edges per call, `ManagedFolio` option `fuel`) is below the 268 million a 65,536-round call needs. Every call exhausted its fuel and reported `fallbacks: 4`, and the owner re-ran the whole kernel serially, so the owner's tail CPU (6.2 to 6.9 s) equals the serial arm's. `object-65536-raised-fuel` raised `fuel` to its maximum (1,000,000,000) for the run and left the default unchanged; the owner's CPU was 78 to 81 ms.
- A 65,536-round Worker-lane run aborted partway after client `fetch failed` errors and has no summary, so it is not recorded here.
- Failures in `object-65536-raised-fuel`: nine requests received no response (`fetch failed`) and one snapshot-arm request returned a platform 500. No returned sample failed its digest check.

## Scope

- One account, one coordinator location, three rounds per cell, one kernel. The kernel touches two memory words per 4,096 rounds of arithmetic, so it measures transport and overlap, not tracking cost.
- Lane CPU for Durable Object calls was not delivered by `wrangler tail`, so the Durable Object rows carry owner CPU and wall only.
- The lane-concurrency run suggests up to about 2.8 times of overlap for four Durable Object lanes; 2.0 times was observed here and the difference is not explained.
- Whether a Durable Object stub call counts toward the 32-invocation per-request limit is not stated in the documentation; the plan counts every lane call.

## Artifacts

Each record directory holds `raw.jsonl`, `tail.jsonl`, `summary.json` and `environment.json`. Tail events keep timing, outcome, route and data center only.

## Reproduction

```sh
node experiments/ranges/prepare.ts
FOLIO_RANGES_LANES=do FOLIO_RANGES_PLAN=paid FOLIO_RANGES_KERNEL=65536 FOLIO_RANGES_ROUNDS=3 \
  FOLIO_RANGES_FUEL=1000000000 FOLIO_RANGES_RECORD=<name> node experiments/ranges/run.ts
node scripts/research/lane-evidence.ts experiments/ranges/runs/<run> results/managed/range-lanes/<record>
```
