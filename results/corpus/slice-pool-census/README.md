# Slice Pool Census

Question: how many of the 30 corpus drivers run correctly and faster on the slice pool, where the caller declares the records independent, and what do unequal record sizes do to automatic admission and to the slice pool?

## Method

`scripts/research/c21-arms.sh` with `C21_ARM_LIST=inplace` ran the 30 bulk drivers through `SlicePool` at their default record counts: eight workers, three sessions of five rounds after two warmups, one fresh process per cell, on the Ryzen 9 9900X under the timing lock (`nice 19`, CPUs 4 to 11, governor `powersave`). A cell that fails its output check against the serial program is recorded in `failed.log` and shown as FAILED; a cell that ran past 180 seconds would be killed, and none was. The module is the unmodified driver with its memory import marked shared, and a driver with a stack pointer global gets one private stack per worker.

The mixed-size runs set `C21_MIXED=1`, which cuts the records of eight programs (xxHash32, xxHash64, xxHash3, Adler-32, CRC-32, SHA-256, SHA-1, MD5) to 1, 1/2, 1/4, 1/8 or 1/16 of their size in a fixed pattern, so the first record is one eighth of the largest. Arms: automatic, forced, explicit private contexts and in place at the even grain (`mixed-sizes.md`); in place at a grain of four records (`mixed-sizes-fine-grain.md`); automatic with the second-chance option (`mixed-sizes-second-chance.md`).

`admission-quality.md` is `scripts/research/admission-quality.mjs` over the automatic, forced and explicit cells of `../record-level-rig/arms.tar.gz` and the in-place cells here. `raw.tar.gz` holds every raw row and log of the four runs, `audit-check.txt` the audit run, and `static-footprint.md` a count of constant-address stores, global writes, indirect calls and imported calls in each driver module (`scripts/research/static-footprint.mjs`). The count does not separate `sha256` from `sha256-shared`: both show no constant-address stores.

## Results

Census, in place, median of the session medians over 30 drivers: 20 run exact at 1.94x to 3.88x. Ten fail the output check in at least one session. They are the drivers with file-scope statics or an allocator cursor: miniz compress and decompress, the four QOI drivers, and the `-shared` variants of JSMN, KissFFT real, AES-CBC decrypt and SHA-256. Four of the ten (`miniz-decompress`, `qoi-decode`, `qoi-decode-64`, `qoi-encode-64`) passed in some sessions and failed in others, the signature of a race on shared state, and the slice pool's audit is the guard for that class. `audit-check.txt` records it on eight failing drivers and four passing ones (Mac, correctness only): the audit agreed on the four, threw `SliceConflictError` on seven of the failing drivers, and the eighth, `sha256-shared`, trapped in a worker.

| mode | geometric mean over 30 loops | loops above 1.0 |
| --- | ---: | ---: |
| automatic | 0.98 | 7 |
| forced | 0.56 | 7 |
| explicit private contexts | 1.89 | 26 |
| in place, declared independent | 2.10 | 20 |
| best exact mode per loop | 2.72 | 30 |

Admission: automatic admits 17 of 30 loops and wins on 7; it refuses all 13 loops where no tracked route wins and none that could. A fixed rule that admits when the serial work is at least 5 ms, fitted on 20 loops with a deterministic split and tested on the other 10, admits 13 loops, all 7 that can win, and has lower mean regret on the test split (0.070 against 0.124) and on the train split (0.114 against 0.196) but higher regret weighted by serial time on the train split (0.398 against 0.182).

Unequal record sizes, speedup over serial at eight workers (equal sizes in brackets, from the record-level rig):

| program | automatic | forced | explicit | in place | in place, grain 4 |
| --- | --- | --- | --- | --- | --- |
| MD5 | 0.98 (1.46) | 1.21 (1.95) | 2.47 (3.07) | 3.09 | 2.65 |
| CRC-32 | 0.98 (1.52) | 1.56 (2.76) | 2.71 (2.93) | 3.15 | 2.80 |
| SHA-256 | 1.41 (2.01) | 1.44 (1.93) | 3.21 (3.33) | 3.63 | 3.20 |
| SHA-1 | 1.24 (1.55) | 1.19 (1.75) | 3.05 (3.33) | 3.26 | 3.16 |
| xxHash32 | 0.88 (0.92) | 0.35 (0.55) | 0.42 (0.48) | 2.34 | 1.63 |

Automatic admission refuses two of the seven winners (MD5 and CRC-32) when the first record is small, and the second-chance option does not recover them (0.98 and 0.99) and costs SHA-256 (1.00). The slice pool is unaffected. A finer grain lowers it, because each slice is a task round trip.

## Scope

- One machine, one record stream per size, and one fixed size pattern. The eight programs are the ones whose records can be cut to any length.
- The admission rule uses `serialMs`, the measured serial time, which Folio also estimates from its first iteration; the comparison says nothing about a rule that must work from static cost alone.
- A race is not always visible in one run. The census counts a driver as passing when every sample of every session equals the serial output, and the audit (`SlicePool` with `audit: true`) is the guard, not this table.
