# Limits

This page lists what Folio does not do and where its measurements stopped, grouped by module. Each
entry names the report section that holds the evidence. The
[Limits and Open Questions](../TECHNICAL_REPORT.md) table in the report is the full list, and each
module page carries a shorter Limits section for its own surface.

A negative result in this list closes one mechanism and leaves the goal open. Where an entry says a
gate was not met, the gate was written down before the run.

## Core

**Accepted input does not guarantee a speedup.** A program with a true serial dependency runs
serially, and a job smaller than the cost of tracking and handing it off loses however independent
its parts are. The automatic routes are measured on library kernels, not on a full application
([Independent Corpus](../TECHNICAL_REPORT.md#independent-corpus)).

**A chain through the state of one message does not split.** SHA-1, SHA-256 and MD5 over one
message, AES-CBC encryption and the 6502 emulator's cycle state each feed one step into the next. A
one-way handoff between two Node threads measured 3.14 microseconds with `Atomics.wait` and 51
nanoseconds with both sides spinning, and an object in production has one thread. Many messages in a
loop are a different case and go through the record route
([Architectural Boundaries](../TECHNICAL_REPORT.md#architectural-boundaries)).

**A recurrence without a known combine stays serial.** The sampling probe refuses FNV-1a and a
SHA-256 compression, and a single long xxHash stream has no combine known to this work. CRC-32,
Adler-32 and AES-CTR have exact combines
([Exact Chunked Recurrences](../TECHNICAL_REPORT.md#exact-chunked-recurrences)).

**Small regions run at the owner.** `prepare` keeps a region at the owner below `minimumRegionWork`
(200,000 estimated units, about 39 microseconds of native work on the machine it was fitted on). A
tracked load or store costs 3,600 units, and the dispatch of one batch costs about 1 ms. The
threshold was calibrated on one machine and gives up speedup for independent regions of 15,000 to
200,000 units
([Static Admission and the Native Fallback](../TECHNICAL_REPORT.md#static-admission-and-the-native-fallback)).

**Automatic extraction found nothing on independent programs.** On 21 kernels from nine projects,
default admission dispatches no worker, and forcing admission makes all 11 kernels that receive
regions between 108 and 45,645 times slower than native. On three unmodified programs (aobench,
6pack with FastLZ, llama2.c at `-O2`) the automatic route stayed serial, with paired ratios of
1.002, 1.002 and 1.001 against a pass line of 1.20
([Independent Corpus](../TECHNICAL_REPORT.md#independent-corpus),
[Unmodified External Programs](../TECHNICAL_REPORT.md#unmodified-external-programs)).

**A loop that wins cannot be told from one that loses before a batch runs.** Calibrating one tracked
iteration separated winners (tracked-to-native ratio 1.0 to 5.8) from losers (3.4 to 6.5) in no
usable way, so the iteration route pays one tracked batch to learn. With the bound stop, the verdict
memory and the short first batch, the wrong-admit slowdown in the 30-driver set has a mean of 1.79x
and a 90th percentile of 2.52x on a loaded laptop
([Architectural Boundaries](../TECHNICAL_REPORT.md#architectural-boundaries),
[Slice Pool, Admission Quality and Mixed Record Sizes](../TECHNICAL_REPORT.md#slice-pool-admission-quality-and-mixed-record-sizes)).

**Cost-bound programs lose under automatic admission.** xxHash32, xxHash64, xxHash3, LZ4 decompress
and Adler-32 have independent records and still do not win automatically. Tracked workers run 4.1 to
4.5 times the native time per iteration on xxHash32, and each batch costs about 1 ms to wake and
join. They win on the slice pool, where the caller declares independence
([Architectural Boundaries](../TECHNICAL_REPORT.md#architectural-boundaries)).

**Iterations that read state another iteration changes can hang.** The SQLite page cache's
hash-chain walk never ended in 9 of 13 attempts on 16 records. The stall guard (`iterationStall`)
stops such a batch and costs 0.9% to 11.2% of worker time on the four programs measured, so it is
off by default and cannot be armed after the fact
([Architectural Boundaries](../TECHNICAL_REPORT.md#architectural-boundaries)).

**Equal to serial means equal memory and return values.** A dispatched iteration run leaves
stack-slot residue in the stack zone and the arena. The guarantee does not cover results that depend
on thread identity, time or allocation addresses, a host import whose effect is not repeatable, or
memory growth during the run ([Correctness Boundary](../TECHNICAL_REPORT.md)).

**There is no automatic PHP speedup on any backend.** Ten userland workloads and the uncached Drupal
render dispatch zero workers on Node. About 90% of one uncached Drupal render is PHP execution on
one thread with no independent unit identified. Explicit speedups exist: 7.65x for regenerating 31
pages on ten private contexts and a 72% cut in first-request cpuTime from a baked boot image
([Work Inside One PHP Request](../TECHNICAL_REPORT.md#work-inside-one-php-request),
[Limits and Open Questions](../TECHNICAL_REPORT.md)).

**A database does not decompose automatically.** The automatic route refuses SQLite or runs it 2.2
times slower, with the 2,048-entry undo log exhausted after 13 regions. A declared decomposition is
exact and fast, such as SQLite shards over a row-id range
([Architectural Boundaries](../TECHNICAL_REPORT.md#architectural-boundaries)).

## Pools

**The task pool checks nothing unless asked.** Tasks that read or write state the serial program
would share return a different result. `audit` reruns every nth task serially and throws
`TaskConflictError`, so it catches an error only on audited tasks
([Correctness Boundary](../TECHNICAL_REPORT.md)).

**The slice pool takes the caller's word.** It refuses a module with a start function, a dropped
data segment or a mutable global other than the stack pointer. Of 30 corpus drivers, 20 ran exact at
1.94x to 3.88x and 10 failed the output check in at least one session. Those 10 share file-scope
statics or allocator cursors. With `audit: true` the pool threw `SliceConflictError` on seven of
eight failing drivers tried and trapped on the eighth
([Slice Pool, Admission Quality and Mixed Record Sizes](../TECHNICAL_REPORT.md#slice-pool-admission-quality-and-mixed-record-sizes)).

**A route that copies each task's records cannot beat a kernel limited by the copy.** The default
copy took xxHash32 at 4,096 records to 0.22 of serial, and a copy microbenchmark moved about 17 GB/s
with one thread and about 18 GB/s with eight. Posting the input without a copy and skipping the
restore of rewritten bytes raised it to 0.92
([Architectural Boundaries](../TECHNICAL_REPORT.md#architectural-boundaries)).

**Task pool speedups depend on a caller-named boundary.** Eighteen of 21 kernels reach 2x or more
with learned-page reset and 8 of 21 with the checkpoint reset. The eight-worker arm varies by up to
1.5x between runs of the same machine
([Explicit Boundaries and Reset Policies](../TECHNICAL_REPORT.md#explicit-boundaries-and-reset-policies)).

## Folds and Certificates

**The stream certifier proves three rings and one rewrite shape.** It covers affine steps over
GF(2), over Z/2^w and over two 16-bit residues of one modulus, plus an in-place byte rewrite. It
refuses a branch on input data or state, a pointer or length used as data, state kept in memory or
globals, imports, a start function and passive data segments. A refusal describes the checker and
says nothing about the function
([Certified Stream Folds](../TECHNICAL_REPORT.md#certified-stream-folds)).

**A stream certificate is evidence from a checker that may have bugs.** Its ground truth is sampled
execution, and it has no formal verification. Two adversary rounds and two code reviews each found a
false certificate, all fixed, and every reviewer shares the author's model family. The verifier
checks lengths 0 to 80 and a short list up to 1,000, seven pointer placements and the declared
memory size, and 18 identity-store modules still disagree with the checker
([Limits and Open Questions](../TECHNICAL_REPORT.md)).

**Certified stream speedups come from six compiled kernels and one probe on one machine.** One pass
on shared memory at eight workers reached 3.4x to 4.1x at 8 MiB and 4.7x to 6.8x at 64 MiB, with
wide session ranges ([Certified Stream Folds](../TECHNICAL_REPORT.md#certified-stream-folds)).

**The ownership certificate covers a minority of the drivers tried.** Six of 10 development drivers
certify against a locked line of 8, which was not met. On the frozen final corpus of 47 drivers, 1
certifies, because every driver there uses the shim's arena allocator. That driver,
`minimp3-mp3dec_init`, ran on the window in 21 of 30 arm64 rounds and 0 of 30 x86_64 rounds
(`router-ablation-final.ts`, on the Ryzen machine and the Apple M2 Pro). The remaining drivers need
program-specific invariants, and `qoa-encode` and `miniz-compress` are true violations
([Ownership Certificate and the Slice Route](../TECHNICAL_REPORT.md#ownership-certificate-and-the-slice-route)).

**An ownership certificate rests on premises the checker does not prove.** The caller's `regions`
and `writes` must be complete, record pointers must stay inside their regions, and the entry may
branch on its loop counters and the record count only to end or repeat its loop. The checker
produced false certificates in three red team rounds, all closed in the frozen checker. The report
calls the six certificates tested, not audited or proved. A `budget` refusal means the analysis hit
its 4,000,000-step limit and says nothing about the program
([Ownership Certificate and the Slice Route](../TECHNICAL_REPORT.md#ownership-certificate-and-the-slice-route)).

**The router missed both speed gates on the final corpus.** The geometric mean over 47 drivers is
0.899 on x86_64 and 0.900 on arm64 against 1.20, and the slowest of the five slowest drivers is
0.594 and 0.561 against 0.90, with no wrong output. The router ran serial on 46 of 47 drivers: 23
refused as `unclassified-dependency` and 23 sat below the route floor. The development geomean of
1.209 has an interval of 1.068 to 1.395, and its constants were fitted on that data. The router adds
correct refusals and a reason for each, and it does not add a speedup on that corpus
([Router and Development Ablation](../TECHNICAL_REPORT.md#router-and-development-ablation),
[Final Corpus and Baselines](../TECHNICAL_REPORT.md#final-corpus-and-baselines)).

## Workers

**Managed Workers cannot share physical memory.** Worker RPC drops the backing-store table,
`MessageChannel` refuses it, and managed Workers expose no way to build parallel agents over one
allocation. The managed backend copies snapshots, and its canonical heap must fit the owner's
isolate. One isolate holds 128 MB
([What Blocks Sharing on Managed Workers](../TECHNICAL_REPORT.md#what-blocks-sharing-on-managed-workers)).

**Service-bound Worker lanes serialize.** At 100 ms of CPU per call, four service-bound lanes take
4.07 times one lane's wall time and four Durable Object lanes take 1.42 times. Durable Object lanes
are the route ([Lane Concurrency](../TECHNICAL_REPORT.md#lane-concurrency)).

**Per-record dispatch does not pay on a lane.** A lane that tracks every access costs 17 to 29 times
the serial time per record with run-encoded sets and 43 to 1,000 times with tuples. The managed wins
are coarse explicit units, such as the range kernel (1.98x to 2.00x) and SQLite shards (2.0x to
9.7x) ([Managed Corpus Transfer](../TECHNICAL_REPORT.md#managed-corpus-transfer)).

**A frame and a snapshot have size limits.** The snapshot limit is 31 MiB by default, and a frame
over `maximumFrameBytes` is not sent, so the call runs at the owner. The Workers RPC argument limit
is 32 MiB. The sparse encoding on a deployed lane and a deployed run at the 31 MiB default are
unmeasured
([Costs, Snapshot Limits and State Loss](../TECHNICAL_REPORT.md#costs-snapshot-limits-and-state-loss)).

**The default fuel makes a long kernel finish serially.** A call that exhausts the default
100,000,000 back-edges finishes at the owner, and the range kernel read 0.84x to 0.90x of serial at
that setting against 1.98x to 2.00x with `fuel` raised to 1e9
([Speculative Fuel](../TECHNICAL_REPORT.md#speculative-fuel)).

**A managed owner does not keep in-memory state between requests.** State was replaced between
separate requests with the object identifier unchanged. The cause of the loss after a 65 second wait
is open ([Limits and Open Questions](../TECHNICAL_REPORT.md)).

## Browser

**The browser backend runs counted loops without JSPI.** `BrowserFolio` extracts one ordinary
counted-loop call over shared memory, and other entries run at the owner. General control-flow
continuation without JSPI is open. The measured figures are 3.45x at eight workers on the Free plan
(n=3, exploratory wall time) and 3.87x on explicit partitions at four workers
([Browser Automatic Extraction Without JSPI](../TECHNICAL_REPORT.md#browser-automatic-extraction-without-jspi)).

**The caller owns the arena.** A failure after native writes closes the pool, and the application
restores a checkpoint before retrying ([Browser Run](../TECHNICAL_REPORT.md#browser-run)).

## Memory

**The platform kill line is about 203 MiB on the meter.** The documented 128 MB and the measured
line are unreconciled, and the meter tracks live heap and not committed heap. The governor guards
linear memory only. It turns a platform memory reset into a failed request and does not bound the
JavaScript-side charge. The right cap for a given build is unmeasured: one build held 113.9 MiB
after its workload, which a 112 MiB cap would refuse
([A Drupal Distribution on Durable Objects](../TECHNICAL_REPORT.md#a-drupal-distribution-on-durable-objects),
[Storage Resets and the Growth Governor](../TECHNICAL_REPORT.md#storage-resets-and-the-growth-governor)).

**Software translation misses its gate.** Per-access translation costs a tau of 1.581 on the stock
front page render, 1.287 on login, 1.088 on admin and 1.184 on the repeated-render ladder, against a
gate of at most 1. Tau is the translated render over the native render minus one. Static check
elision does not close the gap. The optimizing tier reads 0.874 and cannot be set on Workers, so it
is exploratory ([Elastic Memory Study](../TECHNICAL_REPORT.md#elastic-memory-study)).

**Compressed pages on the fault path are closed.** A fault that decodes a compressed page pays only
above about 520 to 850 MiB/s, depending on the store it replaces. The synchronous decoders in
`node:zlib` read 257 MiB/s inside one deployed object (range 180 to 283), so a compressed fault
costs 2.3 to 3.1 times the CPU of an uncompressed read. A decoder above 520 MiB/s in a Worker would
reopen it ([Elastic Memory Study](../TECHNICAL_REPORT.md#elastic-memory-study)).

**Narrow arenas are refuted.** A prediction from the 8 MiB and 32 MiB arms put tau for four and
eight arenas on admin at 0.59 to 0.64. The Ryzen machine read 1.75 to 2.80 for four arenas and 2.84
to 4.30 for eight, because the translator emits one range test per arena and the modules grew from
53 MB to 74 and 102 MB ([Elastic Memory Study](../TECHNICAL_REPORT.md#elastic-memory-study)).

**The guard count is a count.** An instrumented build pays 0.308 guards per access on admin after
login and 0.327 on a cold stock front render. The projected tau of about 0.18 to 0.19 for an epoch
design is a prediction, because no translator emits that design
([Elastic Memory Study](../TECHNICAL_REPORT.md#elastic-memory-study),
[guard-count](https://github.com/gmitch215/folio/blob/master/results/execution/guard-count/README.md)).

**The managed page plane misses its gate.** Dense runs miss the p90 rule on days 1 and 2, the
unpaged pair reads 5.8x, and the time model misses on the chase cells. One call returned after 1,012
s and the cause is not found ([Elastic Memory Study](../TECHNICAL_REPORT.md#elastic-memory-study)).

**No deployed fix completes the failing Drupal distribution routes.** The mechanisms closed so far
are the idle module charge, retained buffers, boot garbage with a directory cache and committed heap
as the meter basis. The objective is open
([A Drupal Distribution on Durable Objects](../TECHNICAL_REPORT.md#a-drupal-distribution-on-durable-objects)).

**Storage resets fell to about 0.6% and did not reach zero.** Moving the alarm at least 5 s ahead on
every request path read 5 of 900 requests (0.56%, Wilson 95% interval 0.24% to 1.29%) against 114 of
900 (12.7%) without it. The cause of the remaining resets is open, and 300 requests per arm cannot
tell a 5 s floor from a 15 s one. Committing with `storage.sync()` before an alarm moves earlier
made resets more frequent: 11 of 150 against 1 of 150
([Storage Resets and the Growth Governor](../TECHNICAL_REPORT.md#storage-resets-and-the-growth-governor)).

## Boot

**A baked image is public with the module.** The heap as it was, including freed memory that was
never zeroed, is in the image, and a secret that was ever in the heap cannot be scrubbed afterwards.
Bake a site whose key and salt are throwaway values and give the replaying site its own. The bake
request's PHP session identifier stays in the image, and the host sets a new one for each request
([Replay-Safety Contract](../TECHNICAL_REPORT.md#replay-safety-contract)).

**A site whose configuration differs boots plain.** The measured cuts apply to a fresh site that
matches the pack. The share of real sites that do, a per-site bake and the page-view cost of spool
serving are unmeasured. As active data segments, an image exceeds the upload limit, so a deployed
host serves it as static assets ([Baked Boot Images](../TECHNICAL_REPORT.md#baked-boot-images)).

**Extension credentials, sockets, transactions and changed drivers are untested.** State kept in
JavaScript, such as handles and open descriptors, is not captured
([Replay-Safety Contract](../TECHNICAL_REPORT.md#replay-safety-contract)).

## Continuation

**The platform sets the event budget and the signal.** An event ran between 29.998 s and 32.476 s of
CPU before it stopped on the signal. The warning arrived in 20 of 30 events of the signal study, and
the 10 that did not return were first events of their objects. The design depends on the lead time
`L`, which no study measures, so the no-termination claim is conditional
([Continuation Across Invocations](../TECHNICAL_REPORT.md#continuation-across-invocations)).

**Only a quiescent point checkpoints.** A suspended JSPI stack does not survive an isolate change:
four of four chains lost theirs. A guest needs a poll on every loop not proved short, and for PHP a
refused stretch longer than one event does not complete
([Continuation Across Invocations](../TECHNICAL_REPORT.md#continuation-across-invocations)).

**The deployed PHP runs are four objects with one workload.** Each recovered from one kill with an
exact restore. No signal park occurred, and recovery from repeated kills was not shown. A deploy can
reset a running object mid-event, which loses at most one event's budget and is not measured
([Continuation Across Invocations](../TECHNICAL_REPORT.md#continuation-across-invocations)).

**A checkpoint hashes the whole memory.** The pass costs time proportional to the memory size at
every checkpoint. On a deployed object a checkpoint took 7.3 ms with no change, 23.7 ms with 4 MiB
changed and 78 ms with 16 MiB changed
([Continuation Across Invocations](../TECHNICAL_REPORT.md#continuation-across-invocations)).

## Unmeasured Areas

- Energy on any route, and aggregate CPU or a price per completed operation on managed Workers.
- A third machine. Timing comes from a Ryzen 9 9900X and an Apple M2 Pro.
- A full application. The corpus holds library kernels and programs built for the study.
- Managed widths other than four, and CPU for the large-snapshot runs.
- Whether review of the harnesses and claims by anyone outside the author's model family changes
  them. No person or other model has reviewed them.

See [Limits and Open Questions](../TECHNICAL_REPORT.md) for the status of each row.
