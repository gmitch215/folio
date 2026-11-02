# BLAKE3 Feasibility

Question: why does default admission refuse the BLAKE3 file loop, and would inline tracking with a
private stack per iteration make it dispatch? The [blake3-consumer](../blake3-consumer/README.md) study
shows the refusal. This study holds the analysis and the prototype that led to the
[iteration route](../iteration-route/README.md), so the numbers in the report's BLAKE3 sections can be
traced to raw records.

## Method

**Analysis.** Run on an Apple M2 Pro (Node 26.8.2) with other work in progress (load 3.3 to 6.6), so its
timings are diagnostic. It used an edited copy of the library (`analysis/fsrc` in `source.tar.gz`) that prints each
region candidate's estimate and records the reader, writer and address of every conflict. The analysis
files are `analysis-*`.

**Prototype.** A standalone binaryen pass adds inline read marks (64-byte granules), write marks (32-byte
granules) and a copy-on-first-write undo record to a module with no host call. A small owner
dispatches iterations to workers over one shared memory, each on its own 32 KiB stack slot, validates in
order and rolls back and replays what fails. The loop body is outlined by hand in C (`hash_one`); the
route in the library does that automatically. Three workloads: `large` (32 inputs of 4 MiB), `small` (128 inputs of
256 KiB) and `mixed` (the 100-input set, 223,053,295 bytes, two inputs of 64 MiB). Each arm is paired with a
serial run in the same round, 9 rounds after 2 warmups, three sessions, one pool alive at a time, width
1 to 8. The `ceiling` arm is the same worker pool with no marks and no validation.

The prototype ran on the Mac (`prototype-mac-*`) and was repeated on the Ryzen 9 9900X (Node 26.10.0,
cores 4 to 11, `nice -n 19`, `powersave` governor; `prototype-rig-*`).

## Results

**Why no region clears the floor.** At the default floor of 200,000 net work the extractor finds 9 pure
functions and admits none. At `minimumRegionWork` 0 it forms 31 regions from 35 sites. The estimate
charges 3,600 units per tracked access, and BLAKE3 does at most 40 units of work per access (compress:
1,291 over 32), so the best site has a net of 0 and `blake3_compress_in_place_portable` has -113,909.
Counting hook calls on a 1 MiB input gives 774,712 tracked accesses (47.3 per block). Tracked execution
runs 92x slower than native on 1 MiB, 42x on 64 KiB and 8x on 4 KiB, which is 0.13 to 0.17 microseconds
per access against the 0.605 that the calibration assigns. A second reason is independent of the
estimate: the default transaction budget of 262,144 bytes is exhausted by the 26 inputs of 256 KiB or more,
which hold 99.4% of the bytes of the 100-input set.

**Why 696 of 4,240 regions replay.** Every conflict is on the shadow stack: one region reads a callee
frame that an earlier region of the same iteration wrote (`finalize_seek` hands its 32 finished bytes to
`memcpy`). None touches the table, the output or the inputs. Giving each iteration its own stack slot
(`analysis-stack-experiment.txt`) leaves all 696 in place, and the same eight reader and writer pairs. The
conflicts are within one iteration, not across iterations.

**Untracked ceiling.** Workers with private stacks and no tracking reach 3.3x on the 100-input set, which two
64 MiB inputs (30% each) bound (`analysis-ceiling-full.json`).

**The prototype, Ryzen machine, width 8.** Speedup over serial, tracked arm, three session medians, and
tracked over the untracked ceiling:

| Workload | Tracked | Ceiling | Tracked over ceiling |
| --- | --- | --- | --- |
| `large`: 32 x 4 MiB | 3.20x, 3.23x, 3.29x | 4.45x, 4.39x, 5.03x | 1.39, 1.36, 1.53 |
| `small`: 128 x 256 KiB | 2.47x, 2.46x, 2.49x | 4.38x, 4.66x, 4.38x | 1.77, 1.89, 1.76 |
| `mixed`: 100-input set | 1.59x, 1.59x, 1.61x | 2.62x, 2.61x, 2.61x | 1.65, 1.64, 1.62 |

Digests and memory equal serial in every sample, and no workload had a replay. The Mac gave 3.73x, 3.20x
and 1.79x for the same cells. One of three rig sessions on `large` misses a 1.5x overhead bound over the
ceiling.

**What the prototype found.**

- Ordered validation has to check write-after-read and write-after-write as well as read-after-write,
  because writes land in place. A negative test (`prototype-test-negative.txt`) shows the
  read-after-write rule alone ends with memory that differs from serial.
- A 64-byte write granule makes the 32-byte output slots of neighbouring iterations share a granule, so
  every batch fails validation (32 of 32 replayed). The 32-byte write granule is the measured design.
- Tracking costs 1.38x to 1.45x of native on one thread (`prototype-test-single.json`). An earlier estimate
  of 1.18x to 1.25x left out the mark for the second granule of an access that crosses a boundary.
- The first Mac run is kept as `prototype-mac-invalid-large-1.jsonl` and is invalid: two arms shared a
  memory, which left stale write bits and skipped the undo capture for tracked runs at widths 2, 4 and
  8. It was fixed and all three sessions were rerun.

## Limits

- The analysis timings are diagnostic (loaded Mac, edited library copy). The rig numbers are the ones
  to quote.
- The prototype outlines the loop body by hand and is not the library. The library's own measurements are in
  the iteration-route study and agree within the spread of the rig sessions.
- One program. The 100-input set is bound by its two 64 MiB inputs at 3.3x before any overhead.

## Reproduction

`source.tar.gz` holds the analysis scripts (`analysis/`), the edited library copy (`analysis/fsrc`) and the prototype
(`prototype/`, with `rig.sh`, `smoke.sh` and `run-tests.sh`). The BLAKE3 sources and inputs are the ones of the
blake3-consumer study; `prototype/gen-sizes.ts` and `analysis/inputs.ts` regenerate the inputs.

## Artifacts

- `analysis-*`: census and estimate listings, the stack experiment output, the conflict traces and the
  ceiling record.
- `prototype-{rig,mac}-{large,small,mixed}-N.jsonl` (N from 1 to 3): raw records, with
  `prototype-*.summary.json` and `prototype-mac-*.table.txt` summaries and `prototype-mac-pooled.md`.
- `prototype-test-*`: equality, negative, random, range, single-thread and test-vector checks.
- `prototype-*-before.log`, `prototype-*-after.log`: load, memory and governor.
- `source.tar.gz`: the scripts above.
- `manifest.json`: byte lengths and SHA256 digests.
