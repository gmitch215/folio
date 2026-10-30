# Iteration Admission

Question: when the iteration route has a loop it could dispatch, does the admission decision made from
the measured first iteration pick the cases where dispatch wins and refuse the ones where it loses?

The route is `Folio.run` on the unmodified BLAKE3 consumer (see [blake3-consumer](../blake3-consumer/README.md)).
Before dispatch the owner runs iteration 0 once on the lowered module, times it, and `admitIteration`
(`src/iteration-admission.ts`) predicts the pooled wall and the serial wall. It admits when the pooled
wall times 1.25 is within the serial wall. A refusal reports `no-admission` with the numbers and runs the
loop in the owner.

## Method

`scripts/research/iteration-admission.ts` sweeps input size (4, 16, 64, 256, 1024 and 4096 KiB) by
iteration count (8, 32 and 128). Each cell pairs three arms in the same round, alternating the order:
a serial native run, `automatic` (what the library decides) and `forced` (a pool that dispatches
regardless, through the module-private `admissionSeam`). Timings cover the call and leave the input copy
outside, as for a program whose memory already holds its data. Inputs cycle through 8 distinct
pseudo-random buffers.

Ryzen 9 9900X, Node 26.10.0, cores 4 to 11, `nice -n 19`, `powersave` governor, one pool alive at a
time, 3 sessions of 5 rounds after 2 warmups, so 15 samples per arm and cell. The widths are 8
(`w8-sweep-N.jsonl`) and 4 (`w4-sweep-N.jsonl`). `fixedMs` was fitted to a Mac sweep and `imbalancePerWorker` to the rig medians of the BLAKE3 study at
widths 2, 4 and 8. Both rig sweeps ran after the constants were fixed, and nothing was changed after
either.

`summary.txt` and `summary.json` (width 8) and `w4-summary.txt` and `w4-summary.json` hold the per-cell
medians that `scripts/research/iteration-admission.ts summary` prints.

## Results

Speedup over the serial run, medians over the 15 samples. `disp` is how many of the 15 `automatic` samples
dispatched.

| Cell | Width 8 forced | Width 8 automatic (disp) | Width 4 forced | Width 4 automatic (disp) |
| --- | --- | --- | --- | --- |
| 4 KiB x 8 to 128 | 0.15 to 0.32x | 0.31 to 0.91x (0/15) | 0.20 to 0.34x | 0.33 to 0.90x (0/15) |
| 16 KiB x 8 to 128 | 0.47 to 0.93x | 0.73 to 0.97x (0 or 1/15) | 0.46 to 0.81x | 0.72 to 0.96x (0/15) |
| 64 KiB x 8 | 0.84x | 0.79x (0/15) | 0.98x | 0.80x (0/15) |
| 64 KiB x 32 | 1.61x | 0.94x (0/15) | 1.43x | 0.95x (0/15) |
| 64 KiB x 128 | 1.98x | 1.95x (15/15) | 1.34x | 1.44x (15/15) |
| 256 KiB x 8 | 1.37x | 0.83x (0/15) | 1.18x | 0.83x (0/15) |
| 256 KiB x 32 | 2.62x | 2.49x (15/15) | 1.74x | 1.73x (15/15) |
| 256 KiB x 128 | 2.79x | 2.83x (15/15) | 1.79x | 1.80x (15/15) |
| 1 MiB x 8 | 1.58x | 1.53x (15/15) | 1.51x | 0.83x (0/15) |
| 1 MiB x 32 | 2.93x | 2.94x (15/15) | 2.09x | 2.05x (15/15) |
| 1 MiB x 128 | 3.18x | 3.25x (15/15) | 2.08x | 2.11x (15/15) |
| 4 MiB x 8 | 1.94x | 1.64x (15/15) | 1.57x | 1.62x (15/15) |
| 4 MiB x 32 | 3.22x | 3.18x (15/15) | 2.15x | 2.15x (15/15) |
| 4 MiB x 128 | 3.29x | 3.43x (15/15) | 2.24x | 2.24x (15/15) |

- **No cell dispatched and lost.** At both widths every cell where `automatic` dispatched ran faster
  than serial. Where forced dispatch lost (every 4 and 16 KiB cell and 64 KiB x 8), the library
  refused.
- **Missed speedups.** Two cells at each width refuse a loop that forced dispatch would have won: 64 KiB x 32 (1.61x at width 8, 1.43x at width 4), 256 KiB x 8 (1.37x, width 8) and
  1 MiB x 8 (1.51x, width 4). The serial wall of all four loops is 1.7 to 6.9 ms.
- **Refusal costs the probe.** A refused loop still ran iteration 0 once, so `automatic` sits at 0.7 to
  0.97x on those cells: tens of microseconds on the smallest loops and 1.4 ms on the 6.9 ms loop of 1 MiB x 8 at width 4.
- The decision follows iteration 0 only. A loop whose iterations differ widely in size can be misjudged;
  the 100-input set of the BLAKE3 study (two inputs of 64 MiB) was not part of this sweep.

Limits: one program, one machine, widths 4 and 8, equal-size iterations, 5 rounds per session. Width 2 is
not swept; the model admits it almost never, because the ideal speedup is below 1.4x. The constants
(`trackingFactor` 1.4, `fixedMs` 2, `imbalancePerWorker` 0.05, `margin` 1.25) were not re-fitted to the
rig. The measured tracking factor on the rig is 1.6 to 1.9 above 64 KiB, so the model predicts a longer
serial wall than the loop has; no sweep cell showed that causing a loss.

## Reproduction

```sh
node scripts/research/blake3-build.ts
node scripts/research/iteration-admission.ts run out.jsonl 5 8
node scripts/research/iteration-admission.ts summary out.jsonl --json summary.json
```

`scripts/research/iteration-admission.sh SESSIONS ROUNDS [OUTPUT_DIRECTORY]` runs the sessions under the
timing lock with `nice -n 19` and cores 4 to 11; `FOLIO_WIDTH=4` selects width 4.

## Artifacts

- `w8-sweep-N.jsonl`, `w4-sweep-N.jsonl` (N from 1 to 3): raw records with the constants in the
  environment row.
- `summary.json` and `w4-summary.json`: the sweep's own `summary` mode over the three sessions of each
  width.
- `summary.txt`, `w4-summary.txt`: the printed tables.
- `before.log`, `w4-before.log`: memory, load and governor at the start of each width.
- `manifest.json`: byte lengths and SHA256 digests.
