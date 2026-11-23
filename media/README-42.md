# Durable Chain

Does a Wasm guest that stops on the signal, checkpoints its memory into Durable Object SQLite, and resumes in the next alarm event finish with the same result as an uninterrupted run? What does a checkpoint cost?

## Instrument

`experiments/continuation/durable` deploys a Durable Object with a 120,000-step chain (the guest from `guests/durable-guest.wat`, hashed page by page with `hash.wat`). Four arms:

- `d1`: ten objects, burn events with the signal, every event's stop reason recorded.
- `d2`: forced read after a burn, to see the state word after the kill.
- `d3`: three full chains. Reported in text only.
- `d5`: checkpoint cost at 0, 4 and 16 MiB of changed memory.

`d0` is a local `wrangler dev` chain with three forced restores, reported in text only.

## Rows

`raw.jsonl` holds one row per Durable Object event (`init`, `burn`, `d2-call`), one row per dirty-size object (`checkpoint-cost`), and two `prose` rows.

## Reproduce

```sh
node experiments/continuation/build.ts
node experiments/continuation/durable/run.ts d1    # deployed arms need account variables
node experiments/continuation/export.ts
node scripts/analyze/continuation.ts
node scripts/research/evidence.ts
```

## Scope

Checkpoint costs are the row count and CPU time measured per object; the rows count includes index writes. The `d3` arm lost its driver output; its numbers come from the tail records as stated in the text.

## Polled returns

`pollReturnCpuMs` gives the cpu of each `ok` burn by event index. Event 2 returns at 32,475 or 32,476 ms, event 3 at 31,975 or 31,976 ms, and event 4 at 29,998 to 30,000 ms. The raw holds no kill line, so `leadMs` is not measured. Event 4 returns at the 30 s line, so it cannot show a lead either.
