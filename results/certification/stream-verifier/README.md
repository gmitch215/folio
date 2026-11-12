# Stream Verifier

Question: does a second implementation of the stream certificate check agree with `certifyStream` on the red-team corpus and on the real subjects, and does it reject certificates that claim more than the module does?

`verifyCertificate` in `scripts/research/certify-verify.ts` and its siblings shares no runtime code with `src/certify.ts` apart from the certificate type and SHA-256. It decodes the module itself, runs the entry with concrete control and symbolic data, unrolls each loop by executing it and re-derives the fold, the table binding and the output proof. The checker and the verifier were written by the same model family, so the agreement below is not an independent review.

Result: on the 1,096 red-team modules the checker accepts 634 and the verifier agrees on all 634. On the 11 certified subjects it agrees at full options. Of 307 one-field mutants of the 11 certificates, the verifier rejects all 245 that change the claim and accepts all 62 that claim no more than the original.

## Inputs

| File | Contents |
| --- | --- |
| `redteam-full.jsonl` | one row per red-team module: the checker verdict (`refused` rows carry only the file) and, for accepted modules, ring, `agrees`, cases and milliseconds. 1,096 rows, 462 refused, 634 accepted, `agrees` true on 634 |
| `subjects.jsonl` | one row per certified subject (7 affine folds and 4 in-place kernels), `agrees` true on 11 of 11 |
| `mutants.log` | one JSON row per certificate mutant with the field changed, whether the claim changes and the verifier verdict, then a total line (307 mutants, 245 change the claim and are rejected, 62 do not and are accepted) and the exit status. The final line is not JSON, which is why the file is a `.log` |
| `finding1.out`, `finding2-0.out`, `finding2-1.out` | the hardening pass's reruns of the round 4 disagreements, see [adversary-round-four](../adversary-round-four/README.md) |
| `mutants.time` | wall time of the mutant run |

## Instrument

`node scripts/research/certify-verify-run.ts subjects`, `mutants` and `redteam DIR SHARD COUNT [full] [EVERY]` write these files. The red-team run uses reduced options (lengths 1 to 24 and 17 pointer-and-length probes). The red-team build directory comes from `scripts/research/certify-redteam.ts` and is not part of this study.

## Limits

The verifier checks lengths 0 to 80 and a short list up to 1,000, seven pointer placements per length and the declared memory size. A defect that appears only at a longer length, at a near-wrap pointer or in a larger memory is outside it. The mutants change certificate fields. Module mutants went through the adversary rounds against the checker, and rounds 2 and 3 did not run through the verifier.
