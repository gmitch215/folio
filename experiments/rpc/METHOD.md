# Ordinary Worker Lanes

Question: can ordinary Workers (no Durable Objects) joined by service bindings serve as parallel
execution lanes, and does sending only a region's bytes recover the speed that a full snapshot copy loses?

## Stage A: overlap

One coordinator Worker and four lane Workers, five scripts on the Free account, bound by service
bindings. A lane runs a CPU loop and returns a checksum. The coordinator awaits `k` lanes at once,
six times in a row ("waves"), because a Worker's clock advances only on I/O and a single call is too
short to read. A cell's compute time is its wall minus the wall of the same cell with an empty loop.

`serializationIndexK4` is the compute time of four concurrent lanes over the compute time of one lane.
1.0 is full overlap and 4.0 is fully serialized. Decision rule, fixed before the run: overlap is
established when the index is at most 1.5. The platform documents that service-bound Workers run on
the same thread of the same server by default; a local workerd process gave 0.99x to 1.01x for the same
shape (TECHNICAL_REPORT, "One workerd process runs CPU-bound requests one at a time").

The `public` arm fetches the lanes through their workers.dev URLs from inside the coordinator. It is a
reachability cell only.

## Stage B: transfer

Set `FOLIO_RPC_STAGE=xfer`. A Wasm kernel (`prepare.ts`) rewrites a 16 KiB partition in place. Four
partitions sit in an arena of 128 KiB, 1 MiB or 8 MiB. Each cell runs four waves, and each wave
transforms every partition once, feeding the previous wave's output forward. Modes:

- `serial`: one lane runs the four partitions one after another and keeps them resident, so it
  transfers each partition once. This is the control.
- `full`: four lanes, and every wave sends each lane the whole arena. This is today's managed shape.
- `range`: four lanes, and every wave sends each lane its 16 KiB partition.
- `retained`: four lanes, the partition is sent once and each lane keeps it between waves.

Every mode returns the partition each wave, so the coordinator holds the canonical bytes. Arena
contents outside the partitions are zeros. Payload bytes are request and response body bytes counted by
the coordinator. Exactness: the digest of every final partition must equal the serial mode's in the same
round. CPU time is not measured; wall and bytes only.

Decision rule, fixed before the run. Transfer is a worthwhile lever when, at the 8 MiB arena, `range`
or `retained` is at least 1.5x faster than `serial`, all digests equal the serial digests, the payload is
at most 5% of `full`, and `full` is slower than `range`. If `full` is not slower than `range` at 8 MiB,
bytes are not the limiting cost on this route.

## Bounds

Free account only (the driver refuses otherwise). One run makes at most 8,000 Worker invocations (the
driver counts every lane call). Free requests are 100,000 a day, so a run uses under 10% of one day's
allowance and $0 of metered charges. User allocations stay below 40 MiB per isolate. The driver snapshots
the account's scripts, namespaces and KV, R2 and D1 ids before deploying, deletes all five scripts at the
end and compares the snapshot. It keeps raw records under `runs/`, which is ignored.

Limits: wall only, one coordinator location, 14 rounds, four lanes. Zero-filled arena bytes could in
principle be handled specially by the platform. A Worker that exceeds 10 ms of CPU on the Free plan fails
the call, and a failed cell is reported as a failure.
