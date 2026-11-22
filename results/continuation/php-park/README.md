# PHP Park

Does an interrupt park inside a PHP interpreter build (a PHP build with the interrupt-park patch) keep the stack, memory and output exact across budget and signal stops, commits and restores?

## Instrument

`experiments/continuation-php` runs a PHP workload (`workload.php`) under a local event protocol. `P1` runs in Node 26 with an in-memory store. `P2` runs in a local Durable Object under `wrangler dev`. Each event records its stop reason, the refusals counted before the park, the stack checks and the commit. The workload has two refused regions: an `array_map` with a closure and a generator loop.

`P0` is the uninterrupted reference.

## Rows

`raw.jsonl` holds one `event` row per event for `P1` and `P2`, and one `run` row per arm, with `P0` as the reference. The markers of each event are counted, not stored.

`raw-output.jsonl` holds one `output` row per arm: the SHA-256 of the output and, for `P0`, its byte length. `P0`'s hash is computed from its output file. `P1` and `P2` carry their hash in their run records (`P1` names it `finalSha256`, `P2` names it `outputSha256`). Neither record holds a byte length, so those rows have `bytes` null. `summary.json` reports `outputEqual` for `P1` and `P2` against `P0`'s hash.

## Reproduce

```sh
FOLIO_PHP_WASM_DIR=<directory with the interpreter module> node experiments/continuation-php/run.mjs P0
FOLIO_PHP_WASM_DIR=<directory with the interpreter module> node experiments/continuation-php/run.mjs P1
node experiments/continuation/export.ts
node scripts/analyze/continuation.ts
node scripts/research/evidence.ts
```

## Scope

Local only. The refused regions delay parks until the next admissible poll, so a region longer than one event never completes. The strict generator-region check is not met in the recorded runs; the rows show each park's reason and refusal count, and the check's reading is left to the study record.

The "not met" reading used the wrong refused region. That check counted the whole generator loop as refused, which the specification got wrong. In the generator loop the first admissible poll is the consumer's `foreach` iteration, inside the loop. The park landed there, at event 42 (reason BUDGET, 26 refusals before it, in both `P1` and `P2`). The `summary.json` counts are unchanged.
