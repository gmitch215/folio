# Footprint

Question: can a serial run of a few records predict which bulk drivers the slice pool runs exactly?

The [slice pool census](../../corpus/slice-pool-census/README.md) ran 30 bulk drivers in place on shared memory. Twenty matched the serial output and ten did not. Eight more drivers from six other projects were built later as a held-out set. This study measures what each driver writes, with no workers, and compares the result with that outcome.

## Method

Each record runs alone from a copy of the baseline memory image, and the bytes that differ afterwards are its write set. The run repeats with `__stack_pointer` moved to the end of memory, and a byte counts only if it changed in both runs, which removes the stack. Bytes inside the record's own output slot, arena slice and configuration slice are removed too. A byte written by two or more records is in the shared set.

Three checks follow on the 38 drivers of `probe.json`, each over the first 6 records:

- carried state: the records run one after another without a reset, forwards and in reverse order, and each output is compared with its fresh-memory output
- stack shift: the output with the stack at the tail is compared with the output of the module as built
- poison: the shared bytes are overwritten with pseudo-random values (2 seeds, 12 trials per driver) and each output is compared with its fresh output

`extra.json` repeats the analysis on 18 records per driver (16 for `md4c-html`, which has 16) and adds three checks: an arena relocation that moves each record's arena slice, a count of shared bytes that stay changed after the sequential run, and a scan of the output region for words that point into the shared range. It also runs six synthetic drivers written to fail one check each.

## Results

The shared set is empty for all 20 drivers that pass the slice pool and non-empty for all 10 that fail, so 30 of 30 labeled drivers are classified correctly. Of the 8 held-out drivers, the two without an allocator (BLAKE2b, wyhash) are empty and the six that allocate are non-empty.

Shared set sizes over 6 records:

| Drivers | Shared bytes |
| --- | ---: |
| 12 allocator users: miniz compress and decompress, QOI (four), brotli (two), QOA (two), yyjson, md4c | 4 to 6 |
| `sha256-shared` | 35 |
| `aes-cbc-decrypt-shared` | 192 |
| `jsmn-parse-shared` | 3,417 |
| `kissfft-real-shared` | 16,359 |

The outputs do not depend on those bytes. Carried-state and reversed runs equal the fresh runs for all 38 drivers. Poisoning changed 0 of 456 outputs. The stack shift changed 0 of 29 outputs; the other 9 modules have no `__stack_pointer` global (`lz4-decompress`, `miniz-crc32`, `miniz-adler32`, `jsmn-parse-slot`, `aes-cbc-encrypt-slot`, `md5-slot`, `jsmn-parse-shared`, `xxhash32`, `xxhash64`) and were not shifted.

Four failing `-shared` drivers have a passing sibling that differs only in where the context struct lives: `sha256-shared` and `sha256`, `aes-cbc-decrypt-shared` and `aes-cbc-decrypt`, `jsmn-parse-shared` and `jsmn-parse-slot`, `kissfft-real-shared` and `kissfft-real`. The siblings write nothing outside their own slots. Moving the shared bytes into per-record storage is enough to empty the set.

Input diversity, 18 records per driver: the classification does not change. The shared set stays empty for the 20 passing drivers, BLAKE2b and wyhash. It grows for three drivers: `jsmn-parse-shared` from 3,417 to 3,424 bytes, `kissfft-real-shared` from 16,359 to 16,365 and `brotli-compress` from 6 to 7. Carried-state and reversed runs still equal the fresh runs on all 38, poisoning changed 0 of 304 outputs, the arena relocation changed 0 outputs on the 15 drivers with an arena, and no output word points into a shared range.

The six synthetic drivers show what the write set alone cannot separate:

| Driver | Behavior | Shared bytes at 6 and 18 records | Failed check |
| --- | --- | --- | --- |
| `clean` | pure function of the record | 0, 0 | none |
| `counter` | increments a static that is read after the loop | 1, 1 | none; the output ignores it |
| `rare` | writes a static when the first input byte is 255 | 0, 1 | none; the first six records miss the trigger |
| `carry` | reads what the previous record wrote | 2, 2 | carried, reversed and poison (8 of 8 outputs) |
| `cursor` | resets a bump cursor from the arena pointer and returns its address | 2, 2 | relocation (4 of 4 outputs) |
| `scratch` | writes a static before it reads it | 4, 4 | none |

`counter` and `scratch` have a non-empty shared set and an output that does not depend on it, so a non-empty set alone does not mean the slice pool fails. `carry` and `cursor` have non-empty sets too, and only the order, poison and relocation checks separate them from `counter` and `scratch`. `rare` has an empty set until a record hits the trigger.

## Limits

- Write sets are byte differences against a baseline. Reads and writes of the value already present are invisible.
- The classifier is scored on the 30 drivers whose pass and fail labels came from the census, and on 8 drivers with no label recorded in the probe. It is not a proof of independence.
- Records are the first 6 (probe) or 18 (extra) of each driver, from one input generator. `rare` shows that a trigger outside those records stays hidden.
- Relocation moves only the arena pointer of a record. Static addresses cannot be relocated without rewriting the module.
- Both records name Node 26.8.2 and no hardware. The rerun that reproduced them ran serially on an M2 Pro. No timing is involved.

## Reproduction

Build the drivers first, as described in the C21 bulk harness section of [`scripts/README.md`](../../../scripts/README.md), then:

```sh
node scripts/research/footprint-probe.ts build/research/footprint/probe.json
node scripts/research/footprint-extra.ts build/research/footprint/extra.json
```

Both scripts refuse to overwrite an existing file. A rerun on an M2 Pro with Node 26.8.2 reproduced both records byte for byte.

## Artifacts

- `probe.json`: per-driver rows for 38 drivers, 6 records each.
- `extra.json`: 6 synthetic and 38 real rows, 18 records each.
- `manifest.json`: byte lengths and SHA256 digests.
