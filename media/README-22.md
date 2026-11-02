# Adaptive Routing

Question: when the same conflicting call shape repeats, does running it natively after two bad runs
recover the lost time?

Two fixture entries conflict by construction: `aliased_program` updates one word in every
iteration and `dependent_program` reads the previous element. Each arm calls one entry 40 times in
a row over 9 rounds (360 calls per arm), with the memory reset before each call and every result
compared with native. Arms are native, the default route at width 8, and the same route with
`adaptiveRouting: true`. Adaptive routing keys a call shape by entry, width, memory size and numeric
arguments. After two runs that mostly replayed or fell back, it runs the shape natively for 16
calls and then probes again. It is off by default.

## Results

Paired median speedup over native at width 8, with process CPU as a ratio of native CPU:

| Entry | Machine | Native | Default | Adaptive |
| --- | --- | ---: | ---: | ---: |
| `aliased_program` | Ryzen | 0.31 ms | 0.62x, CPU 2.7 | 0.99x, CPU 1.0 |
| `aliased_program` | M2 Pro | 0.49 ms | 0.61x, CPU 3.1 | 0.99x, CPU 1.0 |
| `dependent_program` | Ryzen | 1 µs | 0.003x, CPU 291 | 0.20x, CPU 3.0 |
| `dependent_program` | M2 Pro | 1 µs | 0.003x, CPU 349 | 0.25x, CPU 3.0 |

Adaptive routing served 337 of 360 calls natively (`previous-conflicts`) and spent 23 on probes or
the first two runs. It removes most of the penalty and does not remove all of it: the probes and the
route decision still cost time on a 1 µs entry.

The result covers one repeated shape on two synthetic entries. A workload whose arguments change on
every call never repeats a shape, so it gets no benefit. The option stays off by default. Enabling
it by default needs a consumer whose call shapes repeat.

## Reproduction

```sh
node scripts/research/graded.ts build/research/graded 9
node scripts/research/analyze.ts build/research/graded/raw.jsonl summary.json
```

The Ryzen record ran through `scripts/research/matched.sh` with `nice -n 19`, cores 4 to 11 and a
shared timing lock. The M2 Pro record ran unpinned on macOS. The raw files here hold the routing
rows only; the graded cells of the same run are in [graded conflicts](../graded-conflicts/README.md).

## Artifacts

- `ryzen.jsonl`, `m2.jsonl`: raw records, 2,160 samples each (2 entries, 3 arms, 360 calls).
- `ryzen.summary.json`, `m2.summary.json`: paired summaries with routing reason counts.
- `manifest.json`: byte lengths and SHA256 digests.

Sources are identified by SHA256 in each environment row. The Ryzen source archive is in
[reset-policies](../../corpus/reset-policies/source.tar.gz).
