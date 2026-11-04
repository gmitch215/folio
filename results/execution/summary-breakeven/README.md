# Summary Route Break-Even

Question: how many calls does it take to repay the one-time cost of making a compiled stream kernel usable for the [one-pass summary route](../summary-onepass/README.md)?

`scripts/research/summary-coldstart.ts` runs the setup once per input size in a fresh process and times each step with `performance.now()`:

- `probeMs`: `probeAffine` samples the module and returns a model.
- `checkMs`: `checkStream` on the module as built, the conversion to a shared memory import (`toSharedImport`), and `checkStream` on the converted module.
- `compileMs`: `WebAssembly.Module` on the converted bytes.
- `firstCallMs`: starting an 8-worker pool, then the first one-pass call over the whole input, with each worker reading the shared input in place. This includes worker start, instantiation and the first run of the code.
- `secondCallMs`: the next call of the same kind, which stands for a steady call.
- `serialMs`: one call of `update` over the whole input in the main thread.

The input is 1, 8 or 64 MiB, and the kernel is the bitwise CRC-32C of the one-pass study.

## Results

`summary-breakeven-table.mjs` computes the calls after which the saving per call, `serialMs - secondCallMs`, repays the cost. The certification column counts probe plus checker. The last column adds the first call minus a steady call.

| MiB | Probe ms | Check ms | Certification ms | First use ms | Serial ms | Steady ms | Saving ms | Calls to repay certification | Calls to repay certification and first use |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 17.79 | 49.44 | 67.23 | 679.70 | 6.83 | 1.93 | 4.90 | 13.7 | 152.4 |
| 8 | 16.51 | 46.25 | 62.76 | 410.04 | 55.27 | 9.52 | 45.75 | 1.4 | 10.3 |
| 64 | 16.90 | 46.81 | 63.71 | 389.30 | 440.60 | 57.19 | 383.41 | 0.2 | 1.2 |

The certification cost is the same 63 to 67 ms at every size, because it depends on the module and not on the input. The saving per call grows with the input, so certification alone repays itself within about 14 calls at 1 MiB, in 1.4 calls at 8 MiB and within the first call at 64 MiB. Starting the pool and making the first call costs 389 to 680 ms in these files. Counting that cost too, break-even is about 152 calls at 1 MiB, 10 at 8 MiB and 1.2 at 64 MiB. A process that already has a warm pool pays only the certification column.

The figures differ from the planning figures of about 13 calls at 1 MiB, 1.4 at 8 MiB and under 1 at 64 MiB in one place. The 1 MiB file records a 49.44 ms checker, and 67.23 ms over a 4.90 ms saving is 13.7 calls. The planning figure of 13 matches rounded costs (17 ms and 46 ms over 4.90 ms is 12.9). The 8 MiB and 64 MiB figures reproduce.

`compiled-summary.json` is the paired timing of the same compiled module at 4 workers over 8 MiB, 5 rounds in one session, with Node 26.8.2 and no pinning. The median paired speedup over the serial arm is 3.97x for one-pass shared, 3.61x for one-pass copied and 1.99x for two-pass shared, and every sample matches the serial state.

## Limits

- Each size has one cold-start sample and one steady-call sample. The steady call and the first call vary run to run. A rerun on an M2 Pro with Node 26.8.2 gave probe 16.0 to 16.9 ms and checker 44.4 to 46.6 ms, close to the recorded values, and steady calls of 1.36, 25.13 and 67.94 ms at 1, 8 and 64 MiB, against the recorded 1.93, 9.52 and 57.19 ms. The 8 MiB steady call differed by a factor of 2.6, which moves its break-even from 1.4 to about 2. Treat the table as a first estimate and not as a distribution.
- None of the files names a machine or a load average, and the cold-start files do not name a Node version either (`compiled-summary.json` records Node 26.8.2). They were taken on the M2 Pro without pinning, which rests on the run notes and on the agreement of the probe and checker times with the rerun. `summary-coldstart.ts` now writes `node` as well.
- The kernel is one CRC-32C. The checker and probe costs depend on the module, and the saving depends on the kernel's speed, so another kernel gives a different table.
- The comparison is against one serial call in the main thread. It does not count the cost of a caller that cannot use a shared memory import.

## Reproduction

```sh
node scripts/research/summary-certify.ts build/research/summary-cert
FOLIO_MIB=8 node scripts/research/summary-coldstart.ts build/research/summary-cert/stream.wasm build/research/coldstart-w8-m8.json
node scripts/research/summary-breakeven-table.mjs results/execution/summary-breakeven/coldstart-w8-m*.json
node scripts/research/summary-compiled.ts build/research/summary-cert build/research/compiled-summary.json
```

`FOLIO_WIDTH` sets the worker count (default 8) and `FOLIO_MIB` the input size (default 8). Each script refuses to overwrite an existing file. `summary-certify.ts` also writes `certificate.json`, which `summary-compiled.ts` reads to check the digest of the module before it runs.

## Artifacts

- `coldstart-w8-m1.json`, `coldstart-w8-m8.json`, `coldstart-w8-m64.json`: cold-start timings at 8 workers.
- `compiled-summary.json`: paired timing rows of the compiled module at 4 workers, 8 MiB.
- `manifest.json`: byte lengths and SHA256 digests.
