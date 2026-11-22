# Footprints

Read and write footprints of a region, used to decide what a run may reuse, ship or skip. Portable:
the modules import no Node built-ins, so they run in Node, Workers and browsers.

- `ranges.ts`: `RangeSet` (sorted byte ranges), `FootprintCache` (learned ranges per call), and the
  ranges frame codec used by the managed backend.
- `memo.ts`: `RegionMemo`, which reuses a recorded region result while its read bytes are unchanged.
- `read-scan.ts`: reads a bitmap of tracked reads into runs and summarizes marked blocks.
- `read-windows.ts`: learns and checks the fixed and strided read windows of a loop.

No root barrel exports this folder. `src/managed` and `src/iteration` import it directly.
