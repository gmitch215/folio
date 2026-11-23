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
- [reset-commit](reset-commit/README.md)
- [idle-requests](idle-requests/README.md)
- [cpu-bare-objects](cpu-bare-objects/README.md)
- [sync-commit](sync-commit/README.md)

Each study holds `raw.jsonl` (rows written by `experiments/continuation/export.ts`), `summary.json`
(written by `scripts/analyze/continuation.ts`) and `manifest.json`. The four alarm-retirement studies
(`reset-commit`, `idle-requests`, `cpu-bare-objects`, `sync-commit`) keep their records as `raw-<mechanism>.jsonl`, their
trimmed tails as `raw-tail.jsonl`, and a `summary.txt` written by the analyzer named in their README.
No account identifiers are stored here.
