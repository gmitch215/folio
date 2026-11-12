# Final Evaluation

Question: does the complete router meet the pre-registered gates on the 47 frozen final drivers?

Result: no. Gate 3 is met, with 0 wrong outputs in 17,484 rows. Gate 1 is not met: the router geomean is 0.899 on x86_64 (sessions 0.897, 0.900, 0.900) and 0.900 on arm64 (0.894, 0.906, 0.898), against 1.20. Gate 2 is not met: the slowest of the five slowest drivers is 0.594 on x86_64 and 0.561 on arm64, against 0.90. The driver-level bootstrap interval of the geomean is 0.861 to 0.935 and 0.858 to 0.941, and the probability of reaching 1.20 is 0.00 on both. The router ran serial for 46 of 47 drivers: 23 refused as `unclassified-dependency` and 23 below the route floor. One driver, `minimp3-mp3dec_init`, has a window certificate.

## Inputs

| File | Contents |
| --- | --- |
| `raw/x86_64-s1.jsonl`, `raw/x86_64-s2.jsonl`, `raw/x86_64-s3.jsonl` | timing rows of three sessions on the x86_64 rig: 47 drivers, 6 arms, 10 rounds, 2,820 samples each |
| `raw/arm64-s1.jsonl`, `raw/arm64-s2.jsonl`, `raw/arm64-s3.jsonl` | the same on the arm64 Mac |
| `raw/correct-x86_64.jsonl`, `raw/correct-arm64.jsonl` | one correctness round per host, no warm calls, 282 samples each |
| `raw/certify-x86_64.jsonl`, `raw/certify-arm64.jsonl` | certificate or refusal per driver and mode, three repetitions and one persistent-cache pass |
| `analysis.json`, `analysis.md` | per-session and pooled figures, gates, routes, contamination, produced by `analyze.ts` |
| `analyze.ts` | the analysis script, with a self-test (`node analyze.ts --selftest`) |

## Instrument

`scripts/research/final-cases/router-ablation-final.ts` at commit `32d3f10`, sha256 `f92b9820788641c527753191889e211894d2b221209680065c44c064ac9e049b`. It follows `scripts/research/final-cases/prereg/PREREGISTRATION.md`, which was committed before any Folio run on a final driver. One fresh process per driver, arm and round; arms in the development rotation, no seed; 8 workers; 6 warm calls, then one timed `bulk` call; the output of every row is hashed per slot and compared with the frozen native checksum and with the serial row of the same round. Both hosts ran `ROUTER_VERSION` `folio-router-2` and `OWNERSHIP_CHECKER` `folio-ownership-2`. The Mac ran Node 26.8.2 on an Apple M2 Pro. The rig ran Node 26.10.0 in a Docker image on an AMD Ryzen 9 9900X, one container at a time with 10 CPUs and 12 GiB.

Speedup is the median over rounds of the paired ratio serial time over arm time. Gate 1 reads the geometric mean over the 47 router speedups. Gate 2 reads the minimum of the five slowest drivers, and `analysis.md` prints the harness `p10`, the fifth smallest, beside it. A gate counts as met for a host only if it holds in all three sessions.

## Reproduction

```sh
node scripts/research/final-cases/router-ablation-final.ts run scripts/research/final-cases/final-manifest.json out.jsonl --final --dry
node scripts/research/final-cases/router-ablation-final.ts run scripts/research/final-cases/final-manifest.json correct.jsonl --final --session 0 --rounds 1 --warm 0 --workers 8
node scripts/research/final-cases/router-ablation-final.ts certify scripts/research/final-cases/final-manifest.json cache.json certify.jsonl --final
node scripts/research/final-cases/router-ablation-final.ts run scripts/research/final-cases/final-manifest.json s1.jsonl --final --session 1 --rounds 10 --warm 6 --workers 8 --cache cache-s1.json
```

The drivers are built by `scripts/research/final-cases/build-drivers.ts`; the wasm bytes are not in the repository.

## Limits

The Mac was a working machine. Its three sessions are labelled loaded by the load rule (sampler maximum 9.73, 22.74 and 13.67). 189 rows in session 2 and 90 in session 3 were flagged at load 12 or above and are kept in every figure; one row in session 3 was over 50 times its arm median. The rig sessions are quiet, with no flagged row. The load sampler files name running processes and are not exported; `analysis.json` holds their summaries, and every row carries its start and end load. Serial calls of the slowest drivers take 0.002 to 0.04 ms, close to timer resolution. The study did not examine why a driver is refused or falls below the floor, and it did not run the baselines from other systems. Any change to Folio after this run turns the corpus into a development set.
