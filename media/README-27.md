# Iteration Admission

Question: when the iteration route has a loop it could dispatch, does the admission decision pick the cases
where dispatch wins and refuse the ones where it loses?

The route is `Folio.run` on the unmodified BLAKE3 consumer (see [blake3-consumer](../blake3-consumer/README.md)).
The decision uses time that the run itself measures, with no calibrated model of tracking cost:

1. The owner runs iteration 0 as the serial program's own first iteration and times it (`plainIterationMs`).
2. Before any dispatch, `admitIteration` (`src/iteration-admission.ts`) compares the remaining serial time,
   `(trip - 1) * plainIterationMs`, with a floor of `fixedMs * margin` (2 ms times 1.25). A loop under the floor
   runs serially and reports `no-admission` with the numbers.
3. After every batch of up to 32 iterations the executor compares the batch wall (dispatch, validation,
   rollback and replay) with the serial time of its iterations at the speed of iteration 0. A batch is slow
   when its wall times 1.25 exceeds that serial time, and dispatch ends after two slow batches in a row or
   after one batch whose wall is more than 1.5 times the serial time. A first batch also pays for waking the
   workers, so one mildly slow batch is not a verdict.
4. Structural stops end dispatch at once: an exhausted undo log (`log-exhausted`), a frame conflict
   (`frame-carried dependence`) and a batch that replays more than half of its iterations (`dependency`).

The rest of the loop then runs serially, and `iteration.stopped` names the reason.

## Method

`scripts/research/iteration-admission.ts` sweeps input size (4, 16, 64, 256, 1024 and 4096 KiB) by iteration
count (8, 32 and 128). Each cell pairs three arms in the same round, alternating the order: a serial native
run, `automatic` (what the library decides) and `forced` (a pool that dispatches regardless, through the
module-private `admissionSeam`, with the batch rule off). Timings cover the call and leave the input copy
outside, as for a program whose memory already holds its data. Inputs cycle through 8 distinct pseudo-random
buffers.

Ryzen 9 9900X, Node 26.10.0, cores 4 to 11, `nice -n 19`, `powersave` governor, one pool alive at a time,
3 sessions of 5 rounds after 2 warmups, so 15 samples per arm and cell. Width 8 is `w8-sweep-N.jsonl` and
width 4 is `w4-sweep-N.jsonl`. `fixedMs` and `margin` were fixed before this sweep from an earlier Mac sweep
and were not changed after it.

## Results

Speedup over the serial run, medians over the 15 samples. The count in brackets is how many of the 15
`automatic` samples dispatched. Native is the serial wall in milliseconds.

| Cell | Native ms (width 8) | Width 8 forced | Width 8 automatic | Width 4 forced | Width 4 automatic |
| --- | ---: | ---: | --- | ---: | --- |
| 4 KiB x 8 | 0.0 | 0.13x | 0.51x (0/15) | 0.16x | 0.57x (0/15) |
| 4 KiB x 32 | 0.1 | 0.25x | 0.86x (0/15) | 0.23x | 0.83x (0/15) |
| 4 KiB x 128 | 0.4 | 0.26x | 0.87x (0/15) | 0.27x | 0.91x (0/15) |
| 16 KiB x 8 | 0.1 | 0.45x | 0.91x (0/15) | 0.52x | 0.91x (0/15) |
| 16 KiB x 32 | 0.4 | 0.79x | 0.96x (0/15) | 0.69x | 0.97x (0/15) |
| 16 KiB x 128 | 1.7 | 0.73x | 0.98x (0/15) | 0.71x | 0.98x (0/15) |
| 64 KiB x 8 | 0.4 | 1.00x | 0.97x (0/15) | 1.26x | 0.97x (0/15) |
| 64 KiB x 32 | 1.7 | 1.46x | 0.98x (0/15) | 1.13x | 0.98x (0/15) |
| 64 KiB x 128 | 6.9 | 1.57x | 1.66x (15/15) | 1.31x | 1.09x (15/15) |
| 256 KiB x 8 | 1.7 | 1.49x | 0.99x (0/15) | 1.49x | 0.97x (0/15) |
| 256 KiB x 32 | 6.9 | 2.78x | 2.37x (15/15) | 1.73x | 1.72x (15/15) |
| 256 KiB x 128 | 27.7 | 2.41x | 2.45x (15/15) | 1.69x | 1.70x (15/15) |
| 1 MiB x 8 | 6.9 | 1.60x | 1.73x (15/15) | 1.61x | 1.63x (15/15) |
| 1 MiB x 32 | 27.4 | 3.01x | 2.95x (15/15) | 2.01x | 2.01x (15/15) |
| 1 MiB x 128 | 110.5 | 2.86x | 3.03x (15/15) | 2.00x | 2.00x (15/15) |
| 4 MiB x 8 | 27.4 | 2.06x | 2.07x (15/15) | 1.74x | 1.73x (15/15) |
| 4 MiB x 32 | 111.5 | 3.26x | 3.25x (15/15) | 2.10x | 2.12x (15/15) |
| 4 MiB x 128 | 442.5 | 3.32x | 3.29x (15/15) | 2.12x | 2.10x (15/15) |

- **No cell dispatched and lost.** Every cell where `automatic` dispatched ran at 1.09x or more of the serial
  wall, and every cell where forced dispatch lost was refused. The refusals cost 1% to 14% of a serial wall
  of 0.1 to 1.7 ms (0.5x on the 0.03 ms loop of 4 KiB x 8); the overhead of the lowered owner was not
  attributed further.
- **Four refusals gave up a speedup.** The summary flags two wrong decisions at each width: 64 KiB x 32
  (forced 1.46x) and 256 KiB x 8 (1.49x) at width 8, and 64 KiB x 8 (1.26x) and 256 KiB x 8 (1.49x) at
  width 4. The serial wall of these loops is 0.4 to 6.9 ms.
- **One cell stopped part way.** At width 4, 64 KiB x 128 dispatched in every sample and the batch rule
  ended dispatch in 5 of 15, which leaves the cell at 1.09x against 1.31x forced.
- **The floor splits the sweep cleanly.** Cells with a serial wall of 1.7 ms or less are refused and cells
  with 6.9 ms or more dispatch. No cell fell between the two.

Limits: one program, one machine, widths 4 and 8, equal-size iterations, 5 rounds per session. Width 2 is not
swept. `fixedMs` 2 and `margin` 1.25 are not fitted to the rig. The estimate
of a batch's serial time is `iterations * plainIterationMs`, so a loop whose first iteration is much cheaper
or much dearer than the rest can be misjudged; mixed-size loops were not swept. A stop lasts for one call of the
owner; the next call starts again at iteration 0. The time of iteration 0 on the first call of a process was
not separated from later calls.

## Reproduction

```sh
node scripts/research/blake3-build.ts
node scripts/research/iteration-admission.ts run out.jsonl 5 8
node scripts/research/iteration-admission.ts summary out.jsonl --json summary.json
```

`scripts/research/iteration-admission.sh SESSIONS ROUNDS [OUTPUT_DIRECTORY]` runs the sessions under the timing
lock with `nice -n 19` and cores 4 to 11; `FOLIO_WIDTH=4` selects width 4. The summary columns `trk fac`,
`plain/trk` and `imbal` are computed from each report and feed no constant.

## Artifacts

- `w8-sweep-N.jsonl`, `w4-sweep-N.jsonl` (N from 1 to 3): raw records with the constants in the environment row.
- `w8-summary.json`, `w4-summary.json`: the sweep's own `summary` mode over the three sessions of each width.
- `w8-summary.txt`, `w4-summary.txt`: the printed tables.
- `w8-before.log`, `w4-before.log`: memory, load and governor at the start of each width.
- `source.tar.gz`: `src/`, `scripts/research/` and `package.json` as run.
- `manifest.json`: byte lengths and SHA256 digests.
