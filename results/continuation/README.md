# Continuation

Alarm-event signals, JSPI and checkpointed chains, isolate lifetimes, boundary commits and PHP parks. See [Results](../README.md) for the layout and the verification command.

- [signal](signal/README.md)
- [jspi-chain](jspi-chain/README.md)
- [durable-chain](durable-chain/README.md)
- [isolate-life](isolate-life/README.md)
- [boundary-commit](boundary-commit/README.md)
- [deferred-chain](deferred-chain/README.md)
- [checkpoint-cost](checkpoint-cost/README.md)
- [php-park](php-park/README.md)
- [php-poll-cost](php-poll-cost/README.md)

Each study holds `raw.jsonl` (rows written by `experiments/continuation/export.ts`), `summary.json`
(written by `scripts/analyze/continuation.ts`) and `manifest.json`. No account identifiers are stored here.
