# Kernel Results

Question: for each of the 21 corpus kernels, what did each route do?

This study joins existing summaries and measures nothing new. Every cell is a paired median speedup
over native at eight workers, so a value under 1 is slower than native. Cells with two numbers read
Ryzen 9 9900X first and Apple M2 Pro second.

- **Native ms** is one call of the entry on the Ryzen machine, from the [default entry
  repeat](../default-entry-repeat/README.md).
- **Default entry** is `Folio.run` under default admission, which dispatches no worker for any of
  the 21 kernels.
- **Forced admission** sets `minimumRegionWork` to 0 and runs on the Ryzen machine only
  ([forced admission](../forced-admission-complete/README.md)). `serial` means no region was
  extracted, and the figure is how many times slower the speculative run was than native.
- **Whole arena, learned pages and checkpoint** are the three reset policies of eight batched
  `TaskPool` workers on private contexts ([reset policies](../reset-policies/README.md)). The caller
  names the independent operations in all three.

## Results

| Kernel | Native ms | Default entry | Forced admission | Whole arena | Learned pages | Checkpoint |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| LZ4 compress | 0.01 | 0.84 / 1.05 | 108x slower | 0.44 / 2.06 | 3.11 / 3.07 | 1.14 / 2.27 |
| LZ4 decompress | 0.01 | 0.46 / 0.51 | serial | 0.41 / 1.64 | 2.50 / 1.97 | 1.34 / 1.94 |
| miniz compress | 0.27 | 0.98 / 0.97 | 202x slower | 1.52 / 3.62 | 3.92 / 4.78 | 2.88 / 3.70 |
| miniz decompress | 0.03 | 0.85 / 0.94 | 2,733x slower | 0.60 / 2.04 | 2.51 / 4.26 | 1.48 / 2.71 |
| miniz CRC-32 | 0.12 | 0.95 / 0.95 | serial | 0.86 / 2.95 | 3.88 / 5.76 | 2.03 / 3.11 |
| miniz Adler-32 | 0.02 | 0.69 / 0.73 | serial | 0.44 / 1.88 | 2.99 / 3.84 | 1.30 / 2.18 |
| jsmn parse | 0.10 | 0.95 / 0.96 | serial | 0.80 / 3.26 | 4.06 / 5.05 | 1.83 / 3.11 |
| KissFFT complex | 0.01 | 0.61 / 0.47 | serial | 0.43 / 1.73 | 2.61 / 2.23 | 1.18 / 2.06 |
| KissFFT real | 0.01 | 0.61 / 0.53 | serial | 0.43 / 1.69 | 1.86 / 1.97 | 1.57 / 2.13 |
| AES-CBC encrypt | 0.50 | 0.99 / 0.98 | serial | 1.83 / 4.11 | 4.09 / 4.80 | 3.85 / 4.24 |
| AES-CBC decrypt | 1.08 | 0.98 / 1.00 | 888x slower | 3.19 / 5.22 | 4.80 / 4.85 | 4.52 / 5.21 |
| AES-CTR | 0.55 | 0.99 / 0.98 | 1,976x slower | 2.06 / 4.31 | 4.48 / 4.83 | 3.91 / 4.45 |
| xxHash32 | 0.01 | 0.54 / 0.73 | serial | 0.43 / 1.69 | 2.48 / 2.27 | 1.40 / 2.20 |
| xxHash64 | 0.00 | 0.42 / 0.50 | serial | 0.43 / 1.70 | 1.47 / 1.69 | 1.46 / 2.30 |
| xxHash3 | 0.01 | 0.45 / 0.51 | serial | 0.39 / 1.67 | 1.92 / 1.97 | 1.15 / 2.61 |
| QOI encode | 0.06 | 0.90 / 0.91 | 541x slower | 0.64 / 2.23 | 3.57 / 4.21 | 1.48 / 2.49 |
| QOI decode | 0.04 | 0.87 / 0.90 | 45,645x slower | 0.56 / 2.17 | 3.44 / 3.73 | 1.89 / 2.31 |
| SHA-256 | 0.20 | 0.97 / 0.98 | 1,054x slower | 0.92 / 3.69 | 3.79 / 5.15 | 2.52 / 3.93 |
| SHA-1 | 0.15 | 0.95 / 0.97 | 1,402x slower | 0.91 / 3.35 | 3.97 / 4.81 | 2.25 / 3.27 |
| MD5 | 0.10 | 0.94 / 0.98 | 119x slower | 0.65 / 2.89 | 3.44 / 4.61 | 1.88 / 2.89 |
| 6502 emulator | 0.20 | 0.96 / 0.99 | 32,090x slower | 1.00 / 3.88 | 3.93 / 5.16 | 2.34 / 3.65 |

The same table is in `kernels.md`, and `kernels.json` adds the process CPU ratio of each task cell.

- Default entry stays at 0.87x to 1.00x for the 12 kernels whose call takes 0.04 ms or longer. The
  nine shorter calls run at 0.42x to 1.05x, where the wrapper is a large share of the call.
- Forced admission extracted regions from 11 kernels, and every one of them ran 108 to 45,645 times
  slower than native. The 10 others stayed serial.
- Learned pages reach 1.47x to 4.80x on the Ryzen machine and 1.69x to 5.76x on the M2 Pro. The
  checkpoint reaches 1.14x to 4.52x and 1.94x to 5.21x. The whole-arena reset is below 1x for 16
  kernels on the Ryzen machine and above 1x for all 21 on the M2 Pro.
- Repeats of the eight-worker arm differ by up to 1.5x on the same machine (AES-CBC decrypt reads 4.80x
  here and 7.42x in the [changed-page study](../page-reset/README.md)), so a cell is one run.

## Reproduction

```sh
node scripts/research/denominators.ts results/corpus scratch.json results/corpus/kernel-results
```

`scratch.json` is the denominator table, which [its study](../denominators/README.md) keeps; any
path outside the repository works.

## Artifacts

- `kernels.json`: one record per kernel with its native time and the speedup and CPU ratio of every
  route.
- `kernels.md`: the table above.
- `manifest.json`: byte lengths and SHA256 digests.
