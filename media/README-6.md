# Forced Admission Complete

Question: when the admission threshold is set to zero, which corpus entries receive regions, and
does running those regions in parallel pay?

This completes the [interrupted diagnostic](../forced-admission/README.md), which stopped at 16 of
21 cases. Each case runs in its own process with `minimumRegionWork` set to 0, native and Folio at
widths 1, 2, 4 and 8, 3 paired rounds and a 60 second cap per case. Production defaults are
unchanged; this is a diagnostic of what the default threshold declines.

## Results

Twenty cases completed inside the cap. `m6502` reached the cap in the first run (0 samples, SIGTERM,
retained in `m6502-capped.jsonl`), and a separate run with a 900 second cap completed it.

| Outcome | Cases |
| --- | ---: |
| Dispatch workers and run speculatively | 11 |
| Stay on the serial original-module route | 10 |
| Replay or fall back to native | 0 fallbacks, replays in 4 |
| Speculative cases faster than native at any width | 0 of 11 |

The eleven speculative cases are AES-CBC decrypt, AES-CTR, LZ4 compress, MD5, miniz compress and
decompress, QOI encode and decode, SHA-1, SHA-256 and the 6502 emulator. At width 8 their wall time
is between 110 and 45,000 times native: 0.06 ms native against 2,899 ms for QOI decode, 0.2 ms
against 6,987 ms for the 6502 emulator, 0.2 ms against 225 ms for SHA-256. They split work into
thousands of regions (67,600 for SHA-256, 77,824 for AES-CTR, 170,390 for the 6502 emulator), each far smaller than the cost of
dispatching it.

All outputs match native in every sample. The diagnostic supports the default threshold of 200,000
net work units: lowering it on this corpus produces regions and no speedup.

## Reproduction

```sh
node scripts/research/admission-diagnostic.ts build/research/forced 60
FOLIO_CORPUS_ADMISSION=0 node scripts/research/corpus-serial.ts build/research/forced-m6502 3 m6502
```

## Artifacts

- `raw.jsonl`: environment, sample and closed records for the 20 completed cases plus the 900
  second `m6502` run.
- `summary.json`: paired summary generated from `raw.jsonl`.
- `index.json`: the diagnostic's per-case completion table, including the capped `m6502` row.
- `m6502-capped.jsonl`: the records the 60 second `m6502` process wrote before it was stopped.
- `manifest.json`: byte lengths and SHA256 digests.

Three paired rounds per arm is a small sample. The ratios are large enough that the sign and order
of magnitude do not depend on it.
