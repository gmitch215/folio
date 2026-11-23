# Managed

The Workers and Durable Object backend. `index.ts` holds `ManagedFolio`, which runs the original Wasm
stack at an owner and sends compiler-discovered regions to named lanes, and `FolioLane`, the lane side
that runs a region against a frozen snapshot and returns its read and write sets. `ManagedArtifact`,
`ManagedLaneTransport` and `ManagedReport` describe the inputs, the transport and the result.

Lane frames use `../remote/frames.ts`, and region coordination uses `../execution/coordinator.ts`.

`tasks.ts` and `pool.ts` hold the durable lane pool. `TaskTable` is a SQL state machine for named
tasks with leases, attempt counts and a result written once per id. `LanePool` is the coordinator side
over a table and a `LaneTransport`, and `serveLane` is the lane side. The pool does no I/O of its own
beyond SQL, the transport call and the flush the caller passes in.

`outbox.ts` holds `Outbox` and `PermanentError`, a durable outbox for effects such as mail on the same
table. A row has a kind, and the kind's replay policy decides what happens to a running row whose lease
ended: `resend` claims it again, `report` ends it as `failed` so the effect never runs twice. Each row
goes claim, flush, effect, complete, flush. The flush after the claim is what makes `report` mean
something, and `TaskTable.claim` carries the policy test itself so a lost report statement cannot let
a `report` row be claimed again.

## Why the Table Survives a Reset

Every transition is one statement that reads and writes only the row it names, and rows move one way:
`queued` to `running`, `running` back to `queued` or on to `done` or `failed`, and never out of `done`
or `failed`. A statement's guard reads only the row it updates and accepts every non-final state, so
no transition depends on which other statements of the event landed or in what order. A reset that keeps any subset of an event's statements leaves each row in a
state the next `claim` handles. A lost claim leaves the row queued. A lost completion or failure leaves
it running until its lease ends, and the lease replays it.

Writes are durable once an await or a flush has passed them. The pool flushes after `enqueue`, after a
claim and before the claim reaches the lane, and after a completion and before it is acknowledged, so
a lane never runs a task whose claim a reset can still take back, and a lane that was told its result
is stored can rely on that. Failure reports, lease renewals and lease expiry are not flushed, because
losing one only brings a replay. A marker followed by its effect with no flush between can lose the
marker and repeat the effect. That is why the body of a task runs at least once and its result is
written once.

The reset behavior was measured for three reset kinds on a bare Durable Object; see "What a reset
commits" in [Storage Resets and the Growth Governor](../../TECHNICAL_REPORT.md#storage-resets-and-the-growth-governor).
A bare object kept two earlier plain writes across a CPU kill after `await storage.sync()` in 10 of 10
trials, which the pool relies on as `runSlice` does for its attempt row. The pool has not run with
`sync()` in the path of a deployed reset.

Portable: no Node imports. It instantiates precompiled modules and compiles no Wasm. Exported through
`src/workers.ts` as the `./workers` subpath.
