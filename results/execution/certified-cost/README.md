# Certified Route Cost

Question: what does it cost to make a function usable on the certified route, and how many calls repay it?

The route is `certifyStream`, `shareCertified` and `foldCertified` from `src/certify.ts` and `src/certified.ts`. A call reads an 8 or 64 MiB input in place from shared memory on eight workers, runs each chunk once from state zero and combines the end states with the certificate's model. The serial call is the same module on the same memory in the main thread. One fresh process per cell, three sessions, two sizes and six real subjects: 36 cells. Each cell takes 5 samples of certification, 7 steady calls and 7 serial calls, and records the time to prepare and compile the shared module and the first call, which includes starting the pool.

The cells ran on the Ryzen rig (Ryzen 9 9900X, cores 4 to 11) with Node 26.10.0 under the timing lock, `nice -n 19` and `taskset -c 4-11`. The one-minute load average before a cell was 0.00 to 1.41. The three sessions are back-to-back repeats on one day. Every cell checks that the certified fold equals the serial state before it records anything.

## Results

Times are medians of the pooled samples, in milliseconds. Speedup is the median over the three sessions of each session's serial median over its steady median, with the range over sessions in parentheses.

| Subject | Certify | 8 MiB speedup | 64 MiB speedup | Calls to repay certification, 8 and 64 MiB | Calls to repay everything, 8 and 64 MiB |
| --- | ---: | --- | --- | --- | --- |
| crc32c | 7.0 | 3.68x (2.63 to 3.89) | 5.17x (5.14 to 5.21) | 0.3, 0.0 | 17.5, 2.0 |
| crc16 | 103 to 105 | 3.85x (3.82 to 6.72) | 5.91x (4.77 to 7.11) | 9.6, 1.2 | 43.8, 5.2 |
| crc64 | 626 to 629 | 3.80x (3.79 to 3.83) | 6.00x (5.03 to 7.62) | 58.6, 6.4 | 92.4, 10.3 |
| poly31 | 2.2 to 2.7 | 3.75x (3.74 to 3.76) | 4.98x (4.79 to 7.32) | 0.6, 0.1 | 78.6, 8.9 |
| lcg | 1.8 | 3.83x (3.81 to 6.76) | 4.90x (4.63 to 6.77) | 0.4, 0.0 | 73.3, 8.3 |
| miniz-crc32 | 93 to 99 | 3.81x (3.80 to 3.88) | 4.84x (4.82 to 7.69) | 9.3, 1.0 | 43.4, 4.9 |

"Repay everything" adds the time to prepare and compile the shared module (about 20 to 30 ms) and the pool start (about 330 to 360 ms, the first call minus a steady call) to certification. Certification is deterministic, so a certificate is computed once per module digest and reused. `table.md` has every column of the pooled table.

The speedup ranges are wide for the same reason as in the [one-pass study](../summary-onepass/README.md): at eight workers some sessions of a cell sit near 3.8x and others near 7x. The 64 MiB figure for crc32c here (5.2x, with a range of 0.07x) is lower than the 6.4x to 6.8x of that study. The two runs use different code around the same mechanism, and the cause of the gap was not isolated.

The kernels with a table (crc16, crc64, miniz-crc32) certify slower than the others because the checker executes the table-building loop or reads the table for every path; crc64 builds a 2 KiB table concretely in each of its paths. Certification times are for the default block ladder (4, then 16).

## Reproduction

The subject modules come from `scripts/research/affine-build.ts` (`buildSubjects` and `buildMiniz`). On the rig, from a checkout with the modules copied to a directory:

```sh
FOLIO_RIG_NODE=/path/to/node bash scripts/research/certify-cost.sh SUBJECTS_DIRECTORY out
node scripts/research/certify-cost-table.mjs out/s*.json
```

## Artifacts

- `cells/`: the 36 cell records with raw samples.
- `table.md`: the pooled table printed by `certify-cost-table.mjs`.
- `progress.log`: the exit status of each cell in run order.
- `manifest.json`: byte lengths and SHA256 digests.
