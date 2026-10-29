# Default Entry Repeat

Question: do the single-entry timings of the [default-admission study](../serial/README.md)
reproduce when nothing else runs on the host?

The earlier run overlapped other local work. This repeat runs the same 21 upstream entries with
the same arms, native and Folio at widths 1, 2, 4 and 8, 9 paired rounds, on two machines.

## Results

All 21 entries take the serial original-module route on both machines: `mode` is `serial` and no
worker is dispatched. The eight-worker Folio arm runs at 0.42x to 0.99x of native on the Ryzen
machine and 0.47x to 1.05x on the M2 Pro. The slowest ratios belong to entries under 20
microseconds, where the wrapper cost is a large share of a call. The largest per-kernel difference
from the earlier run's eight-worker median is 0.25.

Entries of 0.15 ms and longer (AES, miniz, SHA, MD5, the 6502 emulator) sit between 0.95x and 1.0x. This is a measurement of the route default admission chooses; it contains no speedup claim.

## Reproduction

```sh
node scripts/research/corpus-serial.ts build/research/default-entry 9
node scripts/research/analyze.ts build/research/default-entry/raw.jsonl summary.json
```

The Ryzen record ran through `scripts/research/matched.sh` with `nice -n 19`, cores 4 to 11 and a
shared timing lock. The M2 Pro record ran unpinned on macOS.

## Artifacts

- `ryzen.jsonl`, `m2.jsonl`: raw records, 945 samples each.
- `ryzen.summary.json`, `m2.summary.json`: paired summaries.
- `manifest.json`: byte lengths and SHA256 digests.

Sources are identified by SHA256 in each environment row. The Ryzen source archive is in
[reset-policies](../reset-policies/source.tar.gz).
