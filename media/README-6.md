# Managed Phases

Instrument: [phases](../../../experiments/managed/phases/README.md).
[METHOD.md](../../../experiments/managed/phases/METHOD.md) defines the comparison and clocks.
All eight deployed studies restored their account baseline. Records preserve exact completed
operations and state-loss failures; no memory or return mismatch occurred.

| Record | Completed Operations | State-Loss Failures | Invocation Structure |
| --- | ---: | ---: | --- |
| [separate.json](separate.json) | 77 | 42 | Separate external requests |
| [held.json](held.json) | 78 | 41 | One entry request per cell |
| [reentrant-pilot.json](reentrant-pilot.json) | 8 | 2 | Two self-RPC pilot cells |
| [reentrant.json](reentrant.json) | 77 | 13 | Self-RPC matrix |
| [settled-separate.json](settled-separate.json) | 49 | 12 | Separate external requests after a 65 second tail settle wait |
| [width-four.json](width-four.json) | 36 | 0 | Direct calls, width four, 128 KiB and 8 MiB |
| [large-snapshots.json](large-snapshots.json) | 34 | 2 | Direct calls, width two, 16 MiB and 32 MiB |
| [complete.json](complete.json) | 32 | 0 | Direct calls within an owner invocation |

Each record has a matching `.summary.json`. `settled-separate.json` (61 external requests), `width-four.json` (4) and `large-snapshots.json` (4) are later runs with no SQL calls; the request totals below cover the first five. The settled run feeds the [state-loss analysis](../state-loss/README.md).

At 16 MiB the four automatic operations complete through the lanes with no fallback and 67.1 MB sent per operation. At 32 MiB, the default snapshot limit, every lane call fails: the serialized frame is 33,554,540 bytes against the platform's 32 MiB limit for RPC arguments. The four operations still complete exact through native fallback (`transportFallbacks` 4), and the two diagnostic frame-copy phases fail with the same error. The usable snapshot is therefore below 32 MiB by the frame header. At width four the wire bytes per automatic operation equal the width-two figures (551,776 at 128 KiB, 33,581,920 at 8 MiB); CPU was not recovered for these runs. The final four-operation cells retain identical
instance nonces, module UUIDs and object IDs. One cell has complete live-tail CPU; the others retain
null tail aggregates. [stored.json](stored.json) joins 449 persisted log/event records by request
identity and recovers all 192 expected invocation metrics, completing CPU for all eight final cells.
Five studies made 245 measured external requests plus eight readiness requests,
582 owner RPCs, 688 execution lane RPCs and 224 echo RPCs. Cleanup lane RPCs add at most 314:
the total request upper bound is 2,061. Some state-loss cleanup calls find no pool, so that is
not an exact total. Platform administrative API calls and deployment validation are separate.
The initial refused deployment used global random initialization; its source/log and restored
baseline remain in the ignored run directory.

| Memory | Width | Instrumented Lifecycle Ratio | Snapshot Protocol Bytes / Automatic Operation |
| --- | ---: | ---: | ---: |
| 128 KiB | 2 | 1.189x | 551,776 |
| 128 KiB | 8 | 1.419x | 1,077,696 |
| 8 MiB | 2 | 0.880x | 33,581,920 |
| 8 MiB | 8 | 0.841x | 67,137,984 |

| Memory | Width | Native CPU ms / Completed Operation | Automatic CPU ms / Completed Operation |
| --- | ---: | ---: | ---: |
| 128 KiB | 2 | 300.25 | 398.50 |
| 128 KiB | 8 | 300.25 | 383.75 |
| 8 MiB | 2 | 622.75 | 690.00 |
| 8 MiB | 8 | 635.75 | 871.25 |

CPU uses complete stored invocation telemetry for the entire instrumented lifecycle. It includes
the oracle and diagnostics; it does not isolate region compute, validation or transfer CPU.

Ratios compare one native and one automatic instrumented lifecycle per cell, including oracle,
four operations, diagnostic frame copies, echo fanout and close. They are not warm application
speedups. Larger unused canonical heaps increase wire traffic and reverse the small-arena gain.
First-use/warm automatic latency and every individual report remain in the raw records. The
current implementation still requires the canonical heap to fit its owner.

Public records replace instance/module/object identities with consistent references. Original
tail and inventories include deployment metadata and remain ignored. Source hashes, environment,
raw-file digests and before/after baseline equality are in each public record. Analysis uses the
command in the instrument README; historical source archives remain in the corresponding ignored
run directory. Paid rate equivalents are models; no attributable paid bill was observed.
