# Extraction Blockers

Question: which analysis results keep the 21 corpus entries out of automatic extraction, and would
a single compiler extension change that?

`blockers.json` counts the diagnostics `inspect` reports for each kernel, taken from the coverage
records of the [reset study](../reset-policies/README.md). Reasons that differ only in a number are
merged.

## Results

| Reason | Original module | Shared bit only |
| --- | ---: | ---: |
| Start function | 19 | 19 |
| Shared wasm32 memory required | 19 | 0 |
| Unsupported expression | 18 | 18 |
| Global state | 14 | 14 |
| Data segments require initialization isolation | 11 | 11 |
| Host or non-memory imports | 2 | 2 |
| No region reached the net-work threshold | 21 | 21 |

Importing the memory as shared removes one reason and leaves the rest. Every kernel also fails the
200,000-unit admission floor. The [forced admission study](../forced-admission-complete/README.md)
shows what the floor declines: regions of a few microseconds that are slower in parallel by two to
four orders of magnitude. No checkpoint refusal occurred for any kernel.

Extending the extractor to cover start functions, data initialization or global state would admit
more entries and would not make their regions profitable. This corpus does not support building
one.

## Reproduction

```sh
node scripts/research/derive.ts blockers blockers.json raw.jsonl
```

with a reset record as `raw.jsonl`.

## Artifacts

- `blockers.json`: the histogram and the SHA256 of its input.
- `manifest.json`: byte lengths and SHA256 digests.
