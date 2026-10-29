# Managed Operations

Question: what does one operation cost on managed lanes once setup, the serial oracle, diagnostics
and close are taken out, and how does the first operation differ from later ones?

The [phase studies](../phases/README.md) time a whole lifecycle that includes an oracle, frame-copy
diagnostics and an echo fanout. Here each invocation runs setup, a counted number of operations and
close, with no diagnostics. Invocations with 0, 1 and 5 operations share the same setup, so the
difference between counts isolates the first operation and the later ones. The instrument is the
[phases](../../../experiments/managed/phases/README.md) probe in `measure` mode.

## Method

Free account, width four, 64 regions of 2,097,152 mixing rounds, arenas of 128 KiB and 8 MiB, native
(`parallel: 'off'`) and automatic arms, 3 repeats of each count: 36 invocations in a seeded random
order, one owner per invocation, calls made directly inside the owner so state is not lost between
requests. Every operation compares its scalar and the whole arena with an oracle and passes. CPU is
the sum of stored invocation CPU for the entry, owner and lane events of one invocation, joined by
request identity. 35 of 36 invocations have a complete event set. The 36th (8 MiB, automatic, no
operations) lost one event and is left out of the CPU medians. Wall time per operation is the
difference of external wall time between invocations, and bytes come from each operation's report.
The account baseline was restored. The run made 36 external requests, no SQL calls and no billed
usage.

## Results

Medians of three invocations per count, in milliseconds unless stated.

| Arena | Arm | Setup CPU | First operation CPU | Later operation CPU | Later operation wall | Bytes sent per operation |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 128 KiB | native | 265 | 468 | 211 | 267 | 0 |
| 128 KiB | automatic | 258 | 315 | 304 | 155 | 541,948 |
| 8 MiB | native | 285 | 706 | 405 | 425 | 0 |
| 8 MiB | automatic | 260 | 676 | 676 | 599 | 33,572,092 |

Each automatic operation sends four lane requests and receives 9,828 bytes. Every automatic
operation ran speculatively with no replay, no fallback and no transport fallback.

- **At 128 KiB a later operation is faster in wall time and costs more CPU.** The automatic arm
  finishes a later operation in 155 ms against 267 ms natively (1.72x), and uses 304 ms of CPU
  against 211 ms (1.44x), spread over the owner and four lanes.
- **The first operation is slower than later ones.** In the automatic arm the owner waits 344 to
  574 ms for the first operation and 97 to 158 ms for later ones at 128 KiB, and 601 to 661 ms
  against 334 to 501 ms at 8 MiB. The native arm pays a first-operation CPU premium as well (468
  ms against 211 ms at 128 KiB).
- **At 8 MiB there is no window.** A later operation takes 599 ms against 425 ms natively (0.71x),
  uses 676 ms of CPU against 405 ms (1.67x) and sends 33.6 MB.
- **Setup costs the same in every cell,** 258 to 285 ms of CPU, because the oracle runs serially at
  the owner.

So the measured window on this backend is a small arena reused for several operations. Three
repeats per count is a small sample: CPU for one count varies by up to about 200 ms between
invocations (the native 128 KiB arm reads 541 to 746 ms for one operation), and setup wall time
alone varies from 671 to 1,112 ms, so wall differences below a few hundred milliseconds are not
resolved and a first-operation wall figure from differencing is not reported. Not measured: any
price, a deployed run at the 31 MiB default, widths other than four, and a different kernel.

## Reproduction

```sh
FOLIO_PHASE_ENTRY=measure FOLIO_PHASE_WIDTHS=4 node experiments/managed/phases/drive.ts
node experiments/managed/phases/measure.ts experiments/managed/runs/RUN operations.json
```

`measure.ts` reads the stored telemetry for the run with the Observability query API and saves the
response beside the run, where it stays ignored.

## Artifacts

- `operations.json`: costs per arena and arm, and every invocation with its CPU, wall time and
  per-operation await, bytes and report fields. The stored telemetry response is identified by its
  SHA256.
- `manifest.json`: byte lengths and SHA256 digests.
