# Adversary Round Four

Question: do nine new module families that the earlier rounds did not generate produce a false stream certificate from `certifyStream`, and how does the verifier in [stream-verifier](../stream-verifier/README.md) fare on the same modules?

Result: 5,194 new modules, all distinct by SHA-256, plus 14 control modules. The checker accepted 1,035 and refused 4,158, and issued 0 false certificates. The verifier accepted 1,010 of the 1,035 and rejected 25 certificates that the checker issued and ground truth confirms (18 in `wt-diff`, 7 in `wt-addr`). It accepted 23 borrowed certificates for modules that differ from the certified one only at a length it never runs, and one module ended in a V8 heap failure. These counts predate the hardening pass's changes to the verifier.

| Family | What it generates |
| --- | --- |
| `bm-text` | one-site text mutations of the real subject binaries |
| `bm-byte` | one-byte edits of their code sections that still validate |
| `cg` | random C folds under ten flag mixes |
| `ct` | C trip counts |
| `wt-struct` | WAT structure: `br_table`, nested blocks with results, multi-value |
| `wt-trip` | WAT trip counts with memories up to 4 GiB |
| `wt-diff` | WAT, the smallest unsafe edit |
| `ds` | subject binaries, the smallest unsafe edit |
| `wt-addr` | WAT address arithmetic on small memories |

## Inputs

| Path | Contents |
| --- | --- |
| `results/*.jsonl` | one row per module: id, family, sha256, checker verdict, `kind` (`refused`, `accepted-correct`, a false-certificate kind), milliseconds, ring, output flag, verifier verdict and ground-truth text. `fullA-*.jsonl` is a seeded sample of 90 accepted modules rerun at full verifier options and is not part of the 5,194 |
| `results/hist2-*.json` | the ring-attempt reason histogram of 3,592 refusals |
| `results/big-ptr-0.txt`, `big-len-0.txt` | the 4 GiB memory runs: the input placed at the top of the memory for 129 modules |
| `results/log-*.txt` | per-shard run logs |
| `source/` | the generators (`gen-*.ts`), the harness (`lib.ts`, `run.ts`, `eval-worker.ts`), the shard loops and the summary scripts |

The modules themselves (5,470 `.wasm` files, 21 MB) are not exported. The generators rebuild them from fixed seeds.

## Instrument

`gen-*.ts` write modules and a manifest, `run.ts` evaluates a manifest in shards through `lib.ts`. For each module `lib.ts` runs `certifyStream`, then `verifyCertificate` at reduced options, then ground truth by execution. The scripts in `source/` take their paths relative to the repository root, and the shard loops read `FOLIO_ROOT`. Generator seeds and commands:

```sh
node source/gen-control.ts
node source/gen-bmut.ts 60 40
for s in 1 2 3 4 5 6; do node source/gen-cgram.ts $s 150; done
for s in 1 2 3; do node source/gen-ctrip.ts $s 120; done
for s in 1 2 3 4; do node source/gen-wat.ts $s 150; done
for s in 1 2; do node source/gen-addr.ts $s 120; done
node source/gen-diffsub.ts
```

## Limits

The 4 GiB run covers the 129 accepted `wt-trip` modules that declare a 4 GiB maximum, and all 129 match the result of the same bytes at 1 MiB. Lengths above 2^20 were run on three modules only. SIMD, floating point, exceptions, tail calls, `call_indirect`, other entry layouts and block options were not tried. The adversary and the checker's author are the same model family. The machine was loaded during the run (load average 10 to 35), and no limit in the checker or verifier changed.
