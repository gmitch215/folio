# State Loss

Question: why did the owner lose its in-memory state in the managed phase studies, and is the cause
replacement, routing or the instrumentation?

The [phase studies](../phases/README.md) preserve four request arrangements and a final
direct-invocation arrangement. This study reads those records. For each cell it compares the
identifiers returned by setup with those of later successful operations, groups failures by error
message, and splits them by whether the cell runs the native workload in the owner (`native`) or
through lanes (`automatic`). The `settled-separate` record is a new run of the separate-request
arrangement with the driver's 65 second wait after starting tail, which the older arrangements did
not have in the same form.

## Results

| Arrangement | Failed operations | In native cells | In automatic cells | Later operations in a new module | On a different object |
| --- | ---: | ---: | ---: | ---: | ---: |
| Separate external requests | 42 | 33 | 9 | 14 of 121 | 0 |
| One entry request per cell | 41 | 33 | 8 | 15 of 120 | 0 |
| Self-RPC | 13 | 10 | 3 | 45 of 149 | 0 |
| Separate requests after a settle wait | 12 | 12 | 0 | 4 of 41 | 0 |
| Direct calls in one invocation | 0 | 0 | 0 | 0 of 56 | 0 |

Every failure reports that the owner's state is absent and setup is required. What the records show:

- **Routing is excluded.** The object identifier never differs from setup's in any later operation.
- **The owner's state is replaced.** Some later operations report a new module identifier, and
  every failure finds the state gone. Module identifiers are not isolate identities, so the record
  does not name the platform event.
- **The tail wait removes the automatic-cell failures and not the native-cell ones.** Across the
  three older arrangements, 20 of 96 failures are in automatic cells. After the wait, 0 of 4
  automatic cells lose state and all 4 native cells do, after 1 to 3 successful operations. Four
  cells is a small sample, but the direction matches Cloudflare's documentation that starting tail
  can replace instances.
- **Native cells lose state with or without the wait.** There the owner runs the 64-region workload
  itself, 0.3 s to 0.6 s of CPU per operation. The records correlate the loss with that work and do
  not establish why. Memory size does not explain it, since 128 KiB cells lose state as well.
- **Direct calls in one invocation lose nothing**, in 32 operations across 8 cells.

A reusable session on this backend cannot assume the owner's state survives between requests, and
should either rebuild its state from a request that carries it or run every operation inside one
invocation. The backend does not provide durable recovery of an owner. Whether a longer wait, a
smaller per-operation CPU cost or a different arrangement keeps native cells alive is untested.

## Reproduction

```sh
node scripts/research/derive.ts state-loss state-loss.json separate.json held.json reentrant.json settled-separate.json complete.json
```

with the records from the phase study. The settled run is
`FOLIO_PHASE_ENTRY=separate FOLIO_PHASE_PAGES=2,128 FOLIO_PHASE_WIDTHS=2,4 node experiments/managed/phases/drive.ts`
on a Free account, followed by the analyzer with the role `settled-separate`. It made 61 external
requests, no SQL calls, and restored the account baseline.

## Artifacts

- `state-loss.json`: counts per arrangement and the SHA256 of each input record.
- `manifest.json`: byte lengths and SHA256 digests.
