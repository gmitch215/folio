# JSPI Chain

Does a JSPI suspended stack survive an alarm event boundary, and does it survive a change of isolate?

## Instrument

The same signal probe (`experiments/continuation/signal`) runs the `jspi.wat` guest, which yields through an imported function and keeps its LCG in a local. Each object chains alarm slices until the job finishes or the object changes isolate. Two variants: signal stops only, and a yield every 100 blocks.

## Rows

`raw.jsonl` holds one `chain` row per object and one `slice` row per slice. The `prose` row records a local `wrangler dev` run that was reported in text only, with no stored output.

## Reproduce

```sh
node experiments/continuation/build.ts
node experiments/continuation/signal/run.ts a5    # deployed arm, needs account variables
node experiments/continuation/export.ts
node scripts/analyze/continuation.ts
node scripts/research/evidence.ts
```

## Scope

The suspended stack did not survive any isolate change in the runs recorded here. The short-slice chain moved isolate after about one second of CPU. Slice counts are small (three signal-only chains and one short-slice chain).
