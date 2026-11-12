# Ownership Red Team

Question: does the ownership checker accept a module whose certified route gives different output from serial, and does the router route such a module wrongly?

Result: yes, three times before the fix. Round 2 generated 20,000 modules, the checker accepted 4,301, and 253 of those accepted modules gave output that differed from serial: `memory.size` 62, a data-dependent exit from the record loop 59, and slice base parameters read as data 132 (the summary prints 254 false and 86 premise; seed 2089 moves from false to premise on a rerun, so 253 and 87). After the first fix, the same 20,000 seeds accepted 3,939 and none differed. Round 3 found four more classes in smoke batches before the freeze (two record loops that carry a value, reverse record order, a cell read before the loop and rewritten inside it, and a record pointer plus a flagged offset). On the frozen checker its 20,000-module batch accepted 3,070 and none differed. The router harness ran 960 cases over 208 modules and found one hazard: a call whose `writes` list omits a written range, with a record that traps, returns wrong output on the window route. That is a caller contract, and the `writes` documentation now says so.

## Inputs

| File | Contents |
| --- | --- |
| `raw/rt2-before-fix.jsonl` | round 2, seeds 1 to 20,000, checker before the fix |
| `raw/rt2-after-fix.jsonl` | the same seeds on the fixed checker, before the round 3 classes were closed |
| `raw/rt2-router.jsonl` | 960 router cases |
| `raw/rt3-frozen.jsonl` | round 3, seeds 1 to 20,000, frozen checker `folio-ownership-2` |
| `rt2-before-fix.summary.txt`, `rt2-after-fix.summary.txt`, `rt3-frozen.analysis.txt` | counts printed by the generator and analysis scripts |

## Instrument

`scripts/research/ownership-redteam.ts`, `ownership-redteam-run.ts`, `ownership-redteam-router.ts` and `ownership-redteam-3.ts`. The frozen sources are `src/ownership.ts` c821940b3f6277040a5a39154c4f331576473fd757efd63f14b10d7af55c5f57, `src/ownership-redirect.ts` 51c78d03078335ea16a80db18d8cb0a23986835ebfb3ed640d4d730109bff4d2, `src/ownership-slices.ts` 79f9be10a8bb4904f5dc6d6d8b7c439112dcf5b515ce53e1faf67e826090ad8b and `src/router.ts` 18fca62153bbf077ca7e3089d7f088f41cec2a7d5d4bb57573cf08a16a1c308d.

## Reproduction

```sh
node scripts/research/ownership-redteam-run.ts run 1 20000 rt2.jsonl
node scripts/research/ownership-redteam-run.ts summary rt2.jsonl
node scripts/research/ownership-redteam-3.ts summary rt3.jsonl
```

## Limits

The generators have blind spots. In round 3, 2,455 of 3,070 acceptances carry no attack statement and 8 of 20 frame shapes were never accepted, so a clean batch does not show the checker is free of false certificates. The round 2 rerun on the fixed checker ran on an earlier state of it than the frozen one. A premise store whose written value equals the filler byte can read as `false` in a batch and as `premise` on a rerun. The out-pointer stride, the premise that record pointers stay inside their regions and the stack residue remain listed premises.
