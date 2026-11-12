# Router Memory Equality

Question: for the 12 development allocator drivers, does the tracked route leave the whole linear memory outside the stack zone equal to a serial run?

Result: 24 rows and 72 comparisons (three calls per row) show 0 differing bytes. The negative control, one flipped byte, is detected in 24 of 24 rows. This is one input per driver and it is not a proof.

## Inputs

`memeq.log` has one line per row. Each starts with the word ROW and carries a JSON object: `driver`, `how`, `eligible`, `records`, `memoryBytes`, `stackPointer`, `zone`, `controlDetectsFlip` and `calls[*]` with `outsideRanges` and `outsideBytes`. The file is named `.log` because the ROW prefix makes it invalid JSON Lines.

## Instrument

The comparison script (`memeq.ts`) was a scratch file and is not in `scripts/`. It runs each driver serially and on the tracked route and compares memory outside the stack zone after each call.

## Limits

One input per driver. The comparison was not rerun after the router's later changes.
