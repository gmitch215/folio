# Runtime Concurrency

Question: does stock workerd run CPU-bound requests in parallel, and does the way the Workers are
arranged change that?

Instrument: [workerd-concurrency.ts](../../../scripts/probe/workerd-concurrency.ts), a JS spin loop
sized to about 100 ms, `k` concurrent requests (1, 2, 4, 8, 16), 20 rounds per cell.

## Arms

The probe and the raw records name the arms `a`, `b`, `c` and `d`. The files in `configs/` and `logs/`
use the mechanism names below.

| Record label | File name | Arrangement |
| --- | --- | --- |
| `a` | `single` | one workerd process, one Worker |
| `b` | `front` | one process, four Workers behind a front Worker that forwards through service bindings |
| `c` | `sockets` | one process, four Workers on four sockets |
| `d` | `processes-0` to `processes-3` | four processes, one Worker each |

## Results

The [report](../../../TECHNICAL_REPORT.md) states the finding under "One workerd process runs
CPU-bound requests one at a time". The first run had a threefold base drift between arms of unknown
cause, so the second run is the reported one. Each run directory holds `samples.jsonl` (raw rows with
the arm label), `summary.json`, `table.txt`, the calibration, the generated configs and the logs.

## Runs

- [run-1](run-1/README.md)
- [run-2](run-2/README.md)

## Scope

Mac only, one workerd version, a JS loop that does not involve Folio. The probe did not record how
many isolates workerd created. Historical v1 evidence: original file names are in
[the evidence index](../../index.json).
