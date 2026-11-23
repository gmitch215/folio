# Boundary Commit

Does committing a checkpoint at the end of every budget-stopped event, with the commit written inside a transaction that rolls back when the signal is raised, keep a chain exact across isolate moves?

## Instrument

`experiments/continuation/deferred` with the `bc` mode. The budget starts at 1,000 or 2,000 steps, doubles after each commit, falls to 0.7 of the steps at the first signal, and then grows 2% per commit. `g0` is a local run with a simulated signal at step 5,000 and a cut in the commit of event 6. `g1` is three deployed objects running 120,000 steps with no forced loss.

## Rows

`raw.jsonl` holds one `event` row per event, with the stop reason (`commit`, `signal`, `cut`, `final`), the budget before and after, the end step and the number of rows written. The `g1` events come from the retrace file; the first trace file lacks the event-1 end for two objects. Isolate ids are replaced by ordinals.

`raw-driver.jsonl` holds one `object-final` row per object: the driver's comparison of the final value and the memory SHA-256 with the reference (30,000 steps for `g0`, 120,000 for `g1`). The driver kept the two booleans, not the values, so the rows carry the match results and the reference values.

## Reproduce

```sh
node experiments/continuation/build.ts
node experiments/continuation/deferred/run.ts g1   # deployed arm, needs account variables
node experiments/continuation/export.ts
node scripts/analyze/continuation.ts
node scripts/research/evidence.ts
```

`export.ts` writes `raw-driver.jsonl` from `runs/g0.json`, `runs/g1.json` and `runs/reference.json`. The `g1` object ordinals follow the key order of `runs/g1-bc-retrace.json`, the same order the event rows use.

## Scope

All three moves in the deployed arm followed a commit. No move followed a signal stop, so that boundary is not measured. The end step for two first events comes from the checkpoint note because the end note was missing from the tail; the export records which source each row used.

## Moves and loss

The three moves in `g1` each lost 0 steps. A move's loss is the previous event's end step minus the start step of the event that restored the manifest. `summary.json` lists each move with `lostSteps` and the source of the previous end.

`finalMatch` holds for every object: 3 of 3 in `g1` against the 120,000-step reference, and 1 of 1 in `g0` against the 30,000-step reference. The summary counts objects whose final value and SHA-256 both matched (`finalMatch.finalAndShaMatch`).
