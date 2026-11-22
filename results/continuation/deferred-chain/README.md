# Deferred Chain

Does a checkpoint written only on the same isolate, with the signal stopping each event, keep a chain exact? What does the first isolate move lose?

## Instrument

`experiments/continuation/deferred` runs a 120,000-step chain in five arms:

- `f0`: local, 3,000 steps, drops at slices 7, 15 and 22.
- `f1`: three deployed objects, signal stops, deferred checkpoints.
- `f2`: forced aborts after slices 2 and 4.
- `f3`: mid-event checkpoints with a budget.
- `f4`: placement, 500-step checkpoints until 4,000 steps, then signal stops.

## Rows

`raw.jsonl` holds one `chain` row per object, one `slice` row per slice (restore, steps lost, signal steps, outcome, checkpoint rows) and one `move` row per isolate move in `f4`. Isolate ids are replaced by ordinals.

## Reproduce

```sh
node experiments/continuation/build.ts
node experiments/continuation/deferred/run.ts f1   # deployed arms need account variables
node experiments/continuation/export.ts
node scripts/analyze/continuation.ts
node scripts/research/evidence.ts
```

## Scope

In the forced-abort arm the post-signal write did not land at either forced abort (slices 2 and 4; `signalWrites` in `summary.json` shows `landed` false for both). The driver's abort is a `ctx.abort()` call. The loss recorded by the job row is smaller than the steps that ran during the signal, and the summary reports both numbers. The `f4` placement cutoff causes its moves to lose the signal steps beyond 4,000; this is the design as run, not a fix.

## Moves after signal stops

Every isolate move in `f1` to `f4` followed a slice that ended on the signal, except the `f4` object that the platform reset (`reset: true`). The seven signal-ended moves each lost the whole slice, 33,831 to 36,456 steps. The `f2` move is the seventh signal-ended move. It follows slice 1, which ran to the signal at 34,668 steps, and it loses those 34,668 steps. It does not follow a forced abort: the forced aborts follow slices 2 and 4, and the object stayed on the same isolate across both. The earlier note listed the first, third and fourth runs and left this one out. `summary.json` lists each move with `lostStepsComputed` (previous signal steps minus the restored start) beside the raw `lost` field. The two agree on every move with a signal.

## Move rate

`moveRate` sums the cpu of each object's slices from its first isolate change. A slice is left out and counted in `skippedSlices` when it has no cpu, or when it ran at least 5,000 steps at a rate outside 500 to 2,000 steps per cpu-second. Three slices are left out: two in `f3`, one in `f1` object 2. The `isolate-life` and `boundary-commit` raw rows carry no per-slice cpu, so this study is the only input. No object had a later isolate change. The exposure is 782.6 CPU-s, which gives an upper bound of 3.83e-3 moves per CPU-s and a mean CPU between moves of at least 261 s.
