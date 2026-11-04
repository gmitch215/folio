# Certified Route Cost, Widened

Question: do the residue ring and the in-place output proof keep the cost and the speedup of the certified route, and what does the route cost in CPU time?

Same route and rig as the [first cost study](../certified-cost/README.md): `certifyStream`, `shareCertified` and a fold on eight workers over an 8 or 64 MiB input read in place from shared memory. Four subjects are new: Adler-32 (the `zp` ring) and three kernels that rewrite their input in place, `xlcg` (an LCG keystream, `z2w`), `xshift` (xorshift32, `gf2`) and `xsbox` (xorshift32 through a 256-entry table, `gf2`). The in-place kernels run through `reconstructCertified`, which starts every chunk at the state the model gives it, so each chunk runs once and writes its own bytes. The six subjects of the first study ran again so that all ten have the same instrument. One fresh process per cell, three sessions, two sizes, ten subjects: 60 cells. Each cell takes 5 samples of certification, 7 steady calls and 7 serial calls, and now also the CPU time of the whole process over the steady and the serial rounds, workers included.

Every cell checks that the certified result equals the serial call before it records anything. For the in-place kernels it compares the returned state and every byte of the 8 or 64 MiB buffer.

The cells ran on the Ryzen rig (Ryzen 9 9900X, cores 4 to 11) with Node 26.10.0 under the timing lock, `nice -n 19` and `taskset -c 4-11`, on 2026-11-04 (UTC) from 05:11 on a copy of the repository sources. The one-minute load average before a cell was 0.24 to 2.73, and the cells raise it themselves because they run back to back.

## Results

Speedup is the median over the three sessions of each session's serial median over its steady median, with the range over sessions in parentheses. CPU ratio is the process CPU time per steady call over the CPU time per serial call, median over sessions. Entries are for 8 MiB and 64 MiB.

| Subject | Ring | Certify ms | Speedup, 8 MiB | Speedup, 64 MiB | CPU ratio, 8 and 64 MiB | Calls to repay certification, 8 and 64 MiB | Calls to repay everything, 8 and 64 MiB |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| adler32 | zp | 2.6 to 3.3 | 3.77x (3.67 to 3.87) | 6.18x (5.09 to 7.64) | 1.14, 1.04 | 0.3, 0.0 | 30.4, 3.5 |
| xlcg | z2w | 4.0 | 3.36x (2.36 to 3.44) | 4.90x (3.84 to 6.91) | 1.30, 1.10 | 1.7, 0.2 | 158.7, 19.4 |
| xshift | gf2 | 3.8 | 3.70x (3.68 to 3.77) | 4.73x (4.71 to 4.84) | 1.07, 1.06 | 0.5, 0.1 | 50.4, 6.4 |
| xsbox | gf2 | 11.7 | 3.76x (3.75 to 3.77) | 4.95x (4.83 to 7.07) | 1.10, 1.05 | 1.7, 0.2 | 53.9, 6.1 |
| crc32c | gf2 | 7.0 to 7.2 | 4.09x (3.86 to 4.20) | 6.81x (6.61 to 7.71) | 1.08, 1.02 | 0.3, 0.0 | 17.5, 2.0 |
| crc16 | gf2 | 105 to 106 | 3.79x (3.68 to 3.81) | 5.43x (4.86 to 7.60) | 1.10, 1.04 | 10.0, 1.1 | 44.0, 5.0 |
| crc64 | gf2 | 629 to 632 | 3.74x (3.63 to 3.80) | 6.21x (4.78 to 7.39) | 1.15, 1.03 | 59.9, 6.7 | 94.7, 10.6 |
| poly31 | z2w | 2.9 to 3.0 | 3.78x (3.65 to 3.80) | 4.91x (4.12 to 5.05) | 1.09, 1.07 | 0.6, 0.1 | 76.0, 8.7 |
| lcg | z2w | 3.8 to 4.7 | 3.67x (3.64 to 3.68) | 4.76x (4.64 to 5.13) | 1.10, 1.07 | 0.8, 0.1 | 75.2, 8.7 |
| miniz-crc32 | gf2 | 93 | 3.77x (3.41 to 3.86) | 4.71x (4.71 to 4.79) | 1.07, 1.05 | 8.7, 1.0 | 41.2, 5.0 |

At 64 MiB the CPU ratio is 1.02 to 1.10 for all ten subjects, so the route does the work once and the workers add at most 10% CPU time. At 8 MiB it is 1.07 to 1.30; the pool and the 8 MiB input leave less work per worker, and `xlcg` at 1.30 has the smallest serial call (3.3 ms). "Repay everything" adds the time to prepare and compile the shared module (about 20 ms) and the pool start (about 330 to 370 ms) to certification, as in the first study. `table.md` has every column of the pooled table.

The six subjects of the first study give a different speedup here at 64 MiB for crc32c (6.81x against 5.17x), crc16 (5.43x against 5.91x), crc64 and miniz-crc32, and about the same for lcg and poly31. The two runs use the same code around the mechanism. The range over sessions is wide in both, from 4.7x to 7.7x at 64 MiB, and the cause of the difference was not isolated. One 64 MiB figure from one study does not fix the speedup.

The kernels that rewrite their input run at about the same speedup as their read-only neighbours. `xlcg` is the cheapest serial kernel in the table, so it has the least to gain from eight workers and the highest CPU ratio.

## Reproduction

The subject modules come from `scripts/research/affine-build.ts` (`buildSubjects`, `buildOutputSubjects` and `buildMiniz`). On the rig, from a checkout with the modules copied to a directory:

```sh
FOLIO_RIG_NODE=/path/to/node SUBJECTS="crc32c:crc32c crc16:crc16 crc64:crc64 poly31:poly31 lcg:lcg miniz-crc32:mz_crc32 adler32:adler32 xlcg:xlcg xshift:xshift xsbox:xsbox" \
	bash scripts/research/certify-cost.sh SUBJECTS_DIRECTORY out
node scripts/research/certify-cost-table.mjs out/s*.json
```

## Artifacts

- `cells/`: the 60 cell records with raw samples and CPU times.
- `table.md`: the pooled table printed by `certify-cost-table.mjs`.
- `progress.log`: the exit status of each cell in run order.
- `manifest.json`: byte lengths and SHA256 digests.
