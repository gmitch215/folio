# Ownership Cursor Adversary

Question: when the qoi pair's output cursor is mutated, does the ownership certificate ever accept a module whose slice route differs from serial, and what explains the differences?

Result: 1,324 mutants in the merged file. 779 are refused and 545 are accepted. Of the accepted, 539 equal serial on the slice route and 5 differ. All 5 differences have the same cause: a mutant replaces a base pointer with a record-derived pointer, which breaks the listed premise that record pointers stay inside their regions. 28 mutants break that premise in all, 5 of them visibly. This study predates the red team round 2 fixes; the final-tree audit reran the family and reports 549 accepted of 1,324.

## Inputs

| File | Contents |
| --- | --- |
| `mutants-1.jsonl` to `mutants-7.jsonl` | one row per mutant per run: `outcome`, `route`, `regions` |
| `mutants-merged.jsonl` | the rows the counts above come from |
| `hashes.txt` | SHA-256 prefixes of the qoi modules before and after the ARENA change from 65536 to 65520 |

## Instrument

`scripts/research/ownership-cursor-gate.ts` and a mutant generator that is not part of the repository. Each mutant is certified, and an accepted mutant runs on the slice route and serially and the memories are compared.

## Limits

One accepted row, `delayed-local-2-726-$b`, reads `diverges` in `mutants-merged.jsonl`, `notRunnable` in `mutants-5.jsonl` and `equal` in `mutants-7.jsonl`. The run notes call the first reading a transient child failure, and the files do not show the cause. The check that record pointers stay inside their regions can only be enforced by the router, so a module that breaks the premise can be certified.
