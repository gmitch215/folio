# Varied Inputs

Question: does checkpoint reset stay exact when the same private contexts run different inputs?

The [reset study](../reset-policies/README.md) uses one fixed input per kernel. This study builds
the 21 corpus kernels with a runtime input seed and runs five input profiles (seeds 0 to 4) on two
persistent `TaskPool` workers. JSON inputs change in size and the FFT phases change. Each result is
compared with a fresh native instance that ran the same seed: return value, all 8 MiB of memory
and ordered host effects. Float host effects are compared as IEEE 754 bits, because JSON text
drops the sign of zero.

## Results

210 of 210 comparisons match. No context was recreated and `prepareContext` produced no refusal
for any of the 21 kernels, so every restore used the generalized checkpoint. The record is a
correctness check on 21 library kernels and carries no timing.

## Reproduction

```sh
FOLIO_CORPUS_INPUTS_READY=1 node scripts/research/inputs.ts build/research/inputs
```

Omit the variable to build the input-seeded artifacts first. Use a new output path for each run.
The record ran on an Apple M2 Pro with Node 26.8.2.

## Artifacts

- `raw.jsonl`: environment, 210 comparison records and a closing record.
- `manifest.json`: byte lengths and SHA256 digests.

The environment row names the sources by SHA256. An earlier run of the same command against a
previous revision of `src/compiler.ts` also matched 210 of 210 and is not retained.
