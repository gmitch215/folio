# Ownership Slice Gates

Question: for each driver that `certifyOwnership` certifies, does the in-place slice route (`src/ownership-slices.ts`) produce the same memory and the same trap as a serial run, including when a record traps, and does a negative control that empties the copy-out make the comparison fail?

Result: all six certified drivers equal serial on every run, and each control differs. The gate is a correctness check. The speedup is in [ownership-slice-rig](../ownership-slice-rig/README.md).

| Driver | Runs equal to serial | Trapping runs | Control first differs at byte |
| --- | ---: | ---: | ---: |
| `aes-cbc-decrypt-shared` | 72 of 72 | 36 | 66,064 |
| `sha256-shared` (prefix option) | 72 of 72 | 36 | 65,792 |
| `jsmn-parse-shared` | 72 of 72 | 36 | 65,536 |
| `kissfft-real-shared` (configuration premise) | 108 of 108 | 72 | 1,069,334 |
| `qoi-encode` (ARENA 65520) | 84 of 84 | 36 | 65,550 |
| `qoi-decode` (ARENA 65520) | 84 of 84 | 36 | 65,537 |

Each gate runs widths 1, 2, 4 and 8, three record counts and three generators, and repeats with the table pointer corrupted at several record indices so that a record traps.

## Inputs

`<driver>-drivers.jsonl` has one row per run (`kind` `run`, `difference` -1 when the memory equals serial, `serialTrapped`) and one row per header or summary. `<driver>-control.jsonl` has one `control` row with the first differing byte. The qoi drivers' files are the gates on the ARENA 65520 builds.

## Instrument

`scripts/research/ownership-slices-gate.ts drivers|control OUT` for `aes-cbc-decrypt-shared`, and the sibling gate scripts `ownership-prefix-gate.ts`, `ownership-relational-gate.ts`, `ownership-kissfft-gate.ts` and `ownership-cursor-gate.ts drivers|control OUT ID`. The certificate for each driver comes from `scripts/research/ownership-drivers.ts` with `PREFIX=1` for `sha256-shared`, `ALLOC=1 NO_PROBE=1` for the qoi pair and the configuration premise for `kissfft-real-shared`.

## Limits

The gates ran on the checker as it stood on 10 and 11 November, before the red team round 2 fixes. Each result covers the checker at the time of that gate, and the final-tree audit reran every gate with the same counts. The certificates rest on three premises the checker does not prove: `writes` names every non-window byte a record writes, record pointers stay inside their regions, and the stack pointer is the one non-delta mutable global, by position.
