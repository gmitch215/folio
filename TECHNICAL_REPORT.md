# Technical Report: Shared WebAssembly Memory and Ordered Speculation

Folio runs native WebAssembly across several V8 isolates over one physical memory allocation. A
compiler discovers regions of an ordinary Wasm program that can run apart, workers execute them
against the shared bytes, and an ordered validator keeps the serial result. The original Wasm
instance stays the coordinator: it keeps scalar results, control flow, mutable globals, tables and
host effects.

This document is the engineering reference. It records what the library does, which platform limits
shape each backend, what every route costs, and which claims the evidence does not support.
`src/` holds the library, `tests/` the gate, `scripts/` the build, measurement and analysis tools,
and `experiments/` the deployed and local Cloudflare probes. `results/` holds the raw samples, the
exact source snapshots and the deterministic summaries behind every figure. Each figure names the
instrument that produced it, because a Node wall clock, a deployed `cpuTime` reading and a platform
tail event are not interchangeable.

---

## 🧭 Executive Summary

Folio has three execution backends. They were measured separately and are not one combined system.

| backend         | where it runs                          | memory model                                | best measured result                                                                             |
| --------------- | -------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Node            | co-located `worker_threads` isolates   | one physical allocation, zero copy          | **7.519x** elapsed speedup on eight pinned workers, 4.87% extra CPU work                         |
| Managed Workers | named Durable Object lanes, JSPI owner | copied frozen snapshots, ordered validation | **1.618x** end to end (four lanes, binary fetch)                                                 |
| Browser Run     | Chromium Web Workers                   | one physical 256 MiB Wasm allocation        | **3.449x** automatic extraction at eight workers on FREE; earlier explicit partitions **3.874x** |

|                                                        | measured                                                                                                               | instrument                                                              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Physical sharing across isolates                       | additional RSS **3.871 MiB** for four isolates on a touched 64 MiB backing, against **259.930 MiB** for copied buffers | Node 26.10.0, `results/20261019/`                                       |
| One unannotated entry on several CPUs                  | **7.619x** at eight workers on a compute kernel, CPU ratio 1.037, 207 byte-exact samples                               | Paisley Park, `results/20261019-d/`                                     |
| Normally inlined C, automatic region discovery         | **7.519x** median at eight pinned workers; **5.636x** unpinned                                                         | Paisley Park, `results/20261020-affinity-final/`                        |
| Streaming workload                                     | stops improving near four workers (3.497x at four, 3.474x at eight)                                                    | same sweep family, shared memory system                                 |
| Managed Workers, deployed                              | all **39** rows exact, 64 regions, 2/4/8 distinct module UUIDs per row                                                 | STUDENT account, `experiments/managed/runs/cfw-folio-managed-a627504d/` |
| Browser Run, deployed                                  | eight workers, **40000** exact atomic increments, 256 MiB arena, growth and zero fill                                  | STUDENT account, `experiments/browser/runs/cfw-folio-browser-0e66d825/` |
| Cross-isolate shared memory through managed Worker RPC | refused in both directions; `MessageChannel` refuses SAB                                                               | deployed capability probe                                               |
| Stock workerd to the Node host                         | four distinct Folio threads, all 131072 bytes exact, i64 and void results exact                                        | Miniflare on workerd 1.20260815.1 and again on 1.20261019.1             |
| Real consumer artifacts                                | tinyimg (809,683 bytes) and gmux core (4,303 bytes) match native returns and every memory byte                         | `results/integration-generalized-final.json`                            |

### What Decides the Design

**Sharing is a host property.** V8 can attach several wrappers to one backing store. Ordinary
Worker RPC drops the backing-store table before delivery, `MessageChannel` refuses it, and managed
Workers expose no way to create parallel agents over one allocation. Physical sharing therefore
needs a host Folio controls: Node `worker_threads`, a self-hosted runtime, or a browser.

**The original stack is the continuation.** Folio does not serialize Wasm frames. JSPI suspends the
original Wasm stack while regions run elsewhere, so scalar carry, branches, nested calls and host
effects keep their native semantics.

**Dependencies are validated, not assumed.** Regions with a proved footprint run directly. Others
run on private overlays over a frozen base and commit in original order, with replay on conflict.

**Copying is the managed cost.** The managed route copies one frozen snapshot per lane batch and
measured 1.618x end to end including setup, a serial oracle and close. No isolated kernel timing
exists, so the data neither refutes nor supports fan-out for compute-heavy work on a small arena.
It does show that copying whole arenas will not scale past the owner's memory.

---

## 🎯 Scope and Acceptance

The acceptance answer is "Arbitrary input; preserve serial dependencies." It means Folio accepts
any valid program the host engine accepts, with its required host bindings, and keeps the serial
result. It does not make an unknown dependency a proved serial one, and it does not promise that
every program speeds up.

The input domain is WebAssembly supported by the host engine. It is not arbitrary JavaScript, and
it is not machine code without an adapter. A JS runtime compiled to Wasm can own its guest heap,
and gmux can provide decoded blocks and explicit machine state. Required imports remain the
program's host ABI. No claim covers joining independent JS or Wasm GC heaps through linear memory.

Extraction has explicit admission rules (see Region Extraction). Nothing here claims that a finite
test corpus proves every optimizer transformation correct, that every safe region is recognized, or
that every accepted program is faster.

| Objective                                            | Status                                                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Physical zero-copy backing across distinct isolates  | Implemented and measured on Node: native handle trace, aliasing, atomics, RSS controls, growth, lifetime                                  |
| One entry automatically uses several CPUs            | Final unannotated inlined C: 7.519x median, eight pinned workers, exact full memory                                                       |
| Engine-valid Wasm input accepted                     | Original native instance retained; bytes, ArrayBuffer and Module inputs, memories, opaque refs, initialization, async effects             |
| Dependence preservation                              | Ordered validation and replay, byte overlaps, trap prefixes, budget fallback; scalar carry stays native                                   |
| General automatic region extraction                  | Native CFG coordinator, inline numeric-memory spans, pure call regions, ordered state and effect boundaries                               |
| Managed Workers CPU fan-out                          | Deployed; eight distinct module UUIDs; platform CPU overlap observed                                                                      |
| Workerd execution route                              | Portable client plus authenticated host; stock workerd to four Node isolates                                                              |
| Physical shared memory through managed RPC and ports | Refused in deployed tests; the execution host is the workaround                                                                           |
| Real consumer compatibility                          | tinyimg and gmux core match native; no full consumer adapter                                                                              |
| PHP boot and real Drupal render                      | Local prepared coordinator proved with shipping glue, ROM and SQLite; single owner region, zero worker dispatch; no shared-PHP-heap claim |

---

## 🔬 Mechanism and Correctness

### Physical Sharing

Each isolate gets its own wrapper around the same native backing store. It keeps its own instance,
VM stack, globals, tables and JS heap. The allocation is neither duplicated nor moved away from its
creator.

On Node 26.10.0 the sender retains `GetBackingStore()` and the receiver builds another SAB wrapper
from the same native handle [1][2]. V8 keeps the allocation alive while backing-store references
remain [3]. The mutation, lifetime and copy-control probes test the observable consequences of
that implementation.

### Region Extraction

The fast path recognizes whole void countdown entries with affine i32 parameter updates. It accepts
inline scalar temporaries when every read of a written local is dominated by a write in the same
iteration, merges conditional definitions by intersection, and preserves Wasm operand order,
including `select` and `local.tee`. It refuses reads of the changing remaining count, extra
control-variable mutation, escaping or nested control, and scalar carry. A refusal records analysis
coverage. It does not assert that no parallel algorithm exists.

The generalized compiler (`src/extract.ts`) outlines contiguous inline scalar-memory statements
with numeric live-ins. Modified locals must have no reads outside the span and must be definitely
assigned before reads on every admitted path. Branch targets stay inside the region. These rules
exclude scalar carry across repeated invocations, because capturing a stale local on each loop
iteration would be wrong. The same path extracts discarded calls to transitive effect-free numeric
functions, and tracks loads, stores and bulk operations inside a region.

Region admission is static. `prepare` estimates each candidate in instruction units and keeps it at
its owner below `minimumRegionWork`; see Static Admission and the Native Fallback. A module with no
admitted region gets no control plan and runs as the original Wasm.

The original Wasm engine remains the coordinator. It runs branches, nested loops and calls,
switches, reductions and return values. Helpers evaluate operands in native order, then join
pending regions before canonical memory, global state, growth, host effects or opaque calls.
Opaque calls run with native execution forced, so synchronous reentry cannot spawn untracked work.
Start and data initialization run once in this instance, and workers hold only the outlined or
pure function closure plus the imported shared arena.

JSPI suspends the original stack during joins [4]. Numeric-result controller exports get an
internal promising wrapper; reference-returning exports keep their original ABI. Raw exports and
serial paths select the original bodies through an imported mode global. The generated barrier and
poll cross into JSPI only while an imported `pending` global is raised, which the coordinator does
when a region is queued. Float region arguments are
reinterpreted to i32 or i64 before crossing JS and worker messages, so operands keep their bits. A
native coordinator trap drains earlier queued regions before it surfaces, and bounded polling
prevents an earlier queued trap hiding behind later unbounded control flow.

### Ordered Speculation

Queues hold at most 16 regions per participating worker, and one message carries one lane. Each
worker runs its lane against the frozen base with a separate overlay per region. All lanes finish
before the first commit. Commits and replays follow original region order.

1. Workers read a frozen canonical allocation and keep private byte writes. Reads see their own
   earlier writes, and external reads are tracked.
2. All speculative workers stop before any canonical commit.
3. Regions validate in order. A preceding write that intersects a later read forces replay against
   the committed state. Blind writes commit in order, and byte granularity catches partial and
   unaligned overlaps.
4. A validated trap commits that region's preceding writes, throws at the ordered head and discards
   later speculative results.
5. Fuel or tracking exhaustion discards the overlay. If tracked replay also exhausts, the original
   native head and the rest of that batch run serially.

The lane shares one retained tracking allowance across its results rather than multiplying it by
16, and exhausted later jobs return empty sentinels. A failed snapshot allocation or growth keeps
native execution: an optimization resource refusal never becomes a Wasm trap. The same fallback
covers explicit `runAll` batches whose shared-mirror refresh fails before dispatch.

For deterministic admitted instructions, equal externally sourced reads imply the same region
computation, so ordered writes and return values match serial execution. Fuel lets a region stuck
on stale state yield to the native head. It does not make a nonterminating program terminate. The
design follows established ordered speculative execution [5].

A native guard additionally proves complete memory footprints, finite loops and nontrapping i32
arithmetic for the kernels it admits. Runtime checks reject bounds violations, pointer wrap and
every cross-region read/write or write/write overlap before concurrent canonical writes. Guarded
payload execution has no per-access translation, private overlay, byte log or commit copy.

### Resource Limits and Recursion

The equivalence argument covers admitted deterministic instructions and their instruction-defined
traps. Engine resource exhaustion is a separate boundary: native stack capacity, allocation failure
and process termination vary with placement and instrumentation. Folio does not promise identical
resource-limit thresholds in every isolate. A review found this through recursive calls, so direct
and mutually recursive call components now keep their original bodies at the owner with ordered
joins before entry. Whole-module legacy tracking refuses recursive call graphs. Tests cover native
stack exhaustion and its exact preceding writes.

### Contract With the Host

The host gives Folio exclusive access to the arena while a run is active. External writes or
growth, concurrent raw-export calls, and callbacks that mutate tracked state outside this protocol
break the contract. Prepared plans are trusted build artifacts, and Node JS imports are trusted
host code. They are not a tenant sandbox.

---

## 🧱 Memory and Program State

| State or operation                            | Behavior                                                                                      | Beyond the optimized path                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Shared wasm32 linear bytes                    | One physical backing across Node workers                                                      | Remote memory needs an explicit ownership and transport backend |
| i32 scalar memory, narrow and unaligned       | Byte-exact tracking, guarded native subset                                                    | Unproved footprints use validation                              |
| i64 scalar memory                             | Signed and unsigned narrow reads, all store widths, bit-exact overlay                         | Typed i64 helper ABI                                            |
| f32 and f64 memory                            | Reinterpreted around integer helpers; NaN payloads and signed zero preserved in copied memory | No intermediate Number conversion for stored bits               |
| Numeric return values                         | Scalar and tuple transport, NaN bit metadata where structured clone canonicalizes             | Opaque identities stay native                                   |
| memory.copy and memory.fill                   | Complete bounds before mutation, memmove ordering, bounded tracking                           | Large speculative operations fall back at the native head       |
| Start and data initialization                 | Coordinator initializes once; worker module has neither                                       | Source module owns initialization                               |
| Mutable globals, tables, funcrefs, GC objects | State stays in the original instance; controlled accesses join preceding regions              | Owner handles or explicit lowering could widen coverage         |
| Atomics, size and grow, SIMD memory           | Coordinator and opaque boundaries keep semantics; growth joins first                          | Guarded lowering could admit more computation                   |
| Memory 64 and multiple memories               | Native path with original declarations                                                        | Wide address ABI and per-memory read/write sets                 |
| Owned, unshared memory                        | Original identity, buffer kind and detachment kept; workers share a snapshot                  | Copy once per batch; report copied bytes                        |
| Imported memory                               | Allocate declared wasm32 limits or use a supplied binding                                     | Compiled Module and memory64 limits need explicit bindings      |
| externref and JS identity                     | Values stay at the native call site                                                           | Owner-side capabilities or an explicit guest heap               |
| Host exceptions and effects                   | Drain preceding regions, run once at the owner, keep exception identity                       | Native Wasm stack with JSPI is the continuation                 |
| JSPI suspension                               | Explicit suspending imports and promising exports                                             | No suspension through arbitrary synchronous JS frames           |
| C linear stacks, TLS, allocator state         | Owner keeps opaque and global state                                                           | Concurrent mutation needs disjoint stack or TLS ownership       |
| Cancellation                                  | Worker termination joined; repeated close shares the join                                     | Native partial writes need checkpoint restoration               |

No hard 190 to 200 MiB cutoff exists in the library. Native allocation limits, the module's
declared maximum and the host's memory budget apply. A shared 256 MiB backing on Node does not
prove that a managed provider accounts it once or fits it inside four 128 MB isolate budgets.
Logical address space, committed memory, RSS and provider quota are four different quantities.

An ordinary source memory needs an explicit copy into the worker group before speculative batches,
and committed writes update the owner and the mirror. `memoryMode` and `snapshotBytes` report the
difference. A singleton region at an observation boundary runs at its owner, which avoids both the
message and the snapshot.

---

## 📏 Measurements: Physical Sharing

Paisley Park, Ryzen 9 9900X, Node 26.10.0 with V8 14.6, `nice 19`. Raw sets and exact source
snapshots are in `results/20261019/`, `results/20261019-b/` and `results/20261019-c/`.

| Control                                                        | Result                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Attach one touched 64 MiB shared backing to four isolates, n=3 | additional RSS median 3.871 MiB [3.773 to 3.961]                                    |
| Give four isolates copied 64 MiB buffers, n=3                  | additional RSS 259.930 MiB [259.523 to 260.004]                                     |
| Attach a 256 MiB shared backing                                | about 4 MiB attachment overhead                                                     |
| Wasm atomics plus disjoint ordinary stores                     | 40,000 atomic adds and all ordinary outputs exact                                   |
| Shared growth                                                  | new pages visible and zero-filled through fresh views; old views keep stale lengths |
| Creator exits                                                  | backing stays usable from 4 of 4 surviving holders                                  |

RSS alone does not prove identity. The native-handle implementation, bidirectional mutation,
atomic contention and the copied-buffer control together separate sharing from coincidentally
equal copies. None of this implies zero total private overhead per isolate.

The earlier combined C proof used one unannotated entry over 67,108,864 words, one 268,500,992-byte
shared allocation and a separate expected-output copy used only for verification. All 14 measured
whole-allocation comparisons passed.

| Combined 256 MiB proof, n=7 per arm | median [observed range]      |
| ----------------------------------- | ---------------------------- |
| Serial elapsed                      | 38.985 ms [38.916 to 39.229] |
| Automatic four-isolate elapsed      | 10.625 ms [10.536 to 14.105] |
| Paired speedup                      | 3.663x [2.766 to 3.699]      |
| Total CPU ratio                     | 1.063 [1.054 to 1.069]       |
| Process CPU over elapsed            | 3.896 [2.958 to 3.932]       |

---

## ⚙️ Measurements: CPU Scaling and Taxes

The sweep uses the same unannotated C entry, one shared arena and a serial oracle. CPU affinity
4 to 11 spans eight distinct physical cores on this host (the earlier mask 4,6,8,10 supplied four).
Workers may migrate inside the mask; individual pinning is not claimed. The governor stayed
`powersave`, services kept running and priority was `nice 19`.

Two warmup rounds precede nine rotating measured rounds per arm. Initialization, worker
construction, reference creation and the full byte comparison sit outside the timed span.
Planning, guards, dispatch, join and optional profiling sit inside it. All 207 samples compare the
complete 268,500,992-byte allocation exactly and none was discarded. Peak process RSS was
1,137.20 MiB, which includes several idle pools and the reference allocations. One-minute load
ranged 0 to 0.44. The fixture SHA256 is
`7891b9c96268aef30999ac335abe3ac6f3646d9d1f565c8d5e9365e047abb726`.

| Compute: 4096 words, 32768 mixes | Elapsed median | Paired speedup [range] | Total CPU ratio | CPU / wall |
| -------------------------------- | -------------: | ---------------------: | --------------: | ---------: |
| Untouched serial                 |     150.706 ms |                      1 |               1 |      1.000 |
| Two native workers               |      76.191 ms | 1.976 [1.952 to 1.987] |           1.009 |      1.995 |
| Four native workers              |      38.591 ms | 3.903 [3.892 to 3.932] |           1.017 |      3.974 |
| Eight native workers             |      19.780 ms | 7.619 [7.525 to 7.705] |           1.037 |      7.899 |
| Four tracked workers             |      41.398 ms | 3.640 [3.550 to 3.661] |           1.070 |      3.889 |

More isolates unlock more simultaneous CPU when cores and independent work exist. Eight workers
did about the same computation in one eighth of the time. They did not reduce total CPU work.

With S as serial time over parallel time, R as parallel CPU over serial CPU and A as parallel CPU
over parallel time, A equals S times R times (serial CPU over serial time). The earlier 3.663x
speedup and 1.063x CPU ratio imply about 3.89 simultaneous CPU equivalents, or 91.57% of the
four-core ideal, with 6.274% extra work. The compute result reaches 95.23% of the eight-core ideal
with 3.65% extra CPU. Products of separately summarized medians are approximations, not per-sample
identities.

| Streaming 256 MiB, one mix per word | Elapsed median | Paired speedup | Total CPU ratio |
| ----------------------------------- | -------------: | -------------: | --------------: |
| Untouched serial                    |      38.777 ms |              1 |               1 |
| Two workers                         |      20.415 ms |          1.898 |           1.040 |
| Four workers                        |      11.096 ms |          3.497 |           1.097 |
| Eight workers                       |      11.166 ms |          3.474 |           1.791 |

Compute scales to eight while streaming stops near four. That fits a shared memory system or cache
contention, but no bandwidth or stall counters were collected, so no causal breakdown is claimed.
`maximumWorkers` exposes the cap per run; four is the better choice for the streaming case.

| Cost, compute case                       | Four native |    Four tracked |
| ---------------------------------------- | ----------: | --------------: |
| Longest worker active elapsed, median    |   38.428 ms |       39.418 ms |
| Sum of worker thread CPU, median         |  150.959 ms |      155.655 ms |
| Run elapsed minus longest worker, median |    0.128 ms |        2.085 ms |
| Validation, median                       |           0 |        0.245 ms |
| Commit, median                           |           0 |        0.488 ms |
| Tracked read and write bytes             |     0 and 0 | 16384 and 16384 |

The residual includes dispatch, receipt, scheduling, orchestration and log serialization.
Validation and commit sit inside it, and sums of medians need not equal a median total. Profiling
is opt-in so ordinary jobs do not pay for it.

On the generalized path `workerWallMs` and `workerCpuMs` hold per-region observations. The
no-replay harness knows its round-robin placement and sums each lane before taking the longest.
Taking the largest single region would undercount worker time, and the public arrays do not carry
enough lane metadata to rebuild arbitrary replay schedules.

Tiny jobs lose to dispatch overhead. For a 4096-word stream in the profiled large-arena sweep, raw
execution took 0.01089 ms, the four-worker pool's automatic serial route took 0.02490 ms, and
forced tracking took 3.47807 ms. Work thresholds avoid the large tracking tax but not the API cost,
and microsecond values depend on timers and cache state.

Implemented levers: whole-range native guards remove per-access tracking and commit copies;
pools reuse modules, instances and shared backing; work thresholds keep small proved kernels at
the original entry; `maximumWorkers` limits contention; fuel and byte budgets bound failed
speculation; profiling makes a routing mistake measurable. Further levers have prerequisites and
need matched tests: range or page interval logs instead of per-byte sets, transferable compact
commit logs, guarded SIMD and bulk kernels, NUMA-aware placement, chunk and load-balance tuning,
and learned worker counts per workload.

### Generalized C Entry

`tests/c/generalized.c` compiles to 511 bytes at `-O2` with inlining on. It has branches, a count-up
loop, an inlined compute kernel and a scalar return carried across iterations, with no
caller-defined chunks or access annotations. The compiler discovers 64 dynamic regions while the
owner computes the scalar. Each sample runs 64 words with 2097152 mixes in a 268500992-byte
arena. Two warmup rounds precede seven rotating measured rounds, and all 45 executions compare the
whole arena and return against untouched native execution.

| Normally inlined C, n=7 per arm | Elapsed median | Paired speedup [range] | Total CPU ratio | CPU / wall |
| ------------------------------- | -------------: | ---------------------: | --------------: | ---------: |
| Untouched serial                |     150.485 ms |                      1 |               1 |      1.000 |
| One-worker native route         |     150.555 ms |                  1.000 |           1.000 |      1.000 |
| Two workers                     |      77.759 ms | 1.937 [1.902 to 1.941] |           1.037 |      2.008 |
| Four workers                    |      39.125 ms | 3.832 [2.180 to 3.877] |           1.031 |      3.954 |
| Eight workers                   |      31.827 ms | 4.721 [3.830 to 4.909] |           1.051 |      5.021 |

This is tracked speculation with zero replays and fallbacks, shared canonical backing and zero
snapshots. Four-worker validation and commit medians are 0.015110 and 0.020590 ms; eight-worker
medians are 0.011690 and 0.016300 ms. Eight-worker lane wall times exceed their thread CPU times,
which motivated the placement check below. Peak RSS was 1690.637 MiB, with five comparison arenas,
a verification copy and 14 worker wrappers across pools. Source artifact SHA256 is
`9169ad33306925c9d9a890a8049a8c1e1670464bcff78e0be11da78054b0cc19`, the measured
`source.tar.gz` is `5deff99fe587108b3f378bcf8adcd1244ab7d035930c6bc60e702f00233d601c`, and the raw
`control.jsonl` is `ba815a8e1b60d2febe695061fc04cc1c4ce5dec30ccb907db5c4b0a68d10becf`.
`scripts/analyze/control.ts` regenerates the summary. This is a different workload from the
207-sample sweep, so the speedups are not a matched before and after.

The initial `results/20261020-control/` run stays on record separately. Its eight-worker median was
7.437x with a 4.979 to 7.575x range, but it predates the final lane-budget, allocation-fallback and
idle-lifetime fixes and is not substituted for the final implementation.

### Worker Placement

`results/20261020-affinity-final/` tests the final production source and the same C artifact. Each
width reuses one pool for both placement arms. Linux worker TIDs are found before and after pool
creation, checked to belong to this process and verified after every affinity change. Unpinned
workers may use CPUs 4 to 11; pinned workers each use a distinct physical core in that mask.
Affinity commands and full-memory checks sit outside timed intervals. Two warmup rounds and seven
rotating measured rounds give 72 exact executions (56 measured), and every return and all
268500992 bytes match untouched native execution. No sample was discarded.

| Workers / placement | Elapsed median | Paired speedup [range] | CPU work / serial | CPU / wall |
| ------------------- | -------------: | ---------------------: | ----------------: | ---------: |
| Serial oracle       |     150.676 ms |                      1 |                 1 |      1.000 |
| Two, unpinned       |      77.738 ms | 1.935 [1.665 to 1.943] |             1.031 |      1.995 |
| Two, pinned         |      77.992 ms | 1.935 [1.927 to 1.941] |             1.033 |      1.996 |
| Four, unpinned      |      41.962 ms | 3.595 [2.357 to 3.866] |             1.030 |      3.710 |
| Four, pinned        |      39.148 ms | 3.853 [3.824 to 3.861] |             1.030 |      3.968 |
| Eight, unpinned     |      26.627 ms | 5.636 [3.438 to 6.354] |             1.058 |      5.982 |
| Eight, pinned       |      20.062 ms | 7.519 [6.349 to 7.550] |             1.049 |      7.893 |

Pinning improves the eight-worker paired result by 1.215x median [1.188 to 2.032]. The largest
per-lane gap between wall time and thread CPU falls from 3.543 ms to 0.871 ms. Worker CPU and total
process CPU stay similar, so placement recovers elapsed concurrency without reducing arithmetic
work. The earlier `results/20261020-affinity/` run stays intact (eight-worker paired median
improvement 1.291x, with a slower paired sample in the 0.739 to 1.552 range). The final run has no
slower eight-worker pair, but seven pairs do not establish a universal improvement. Per-core procfs
counters use 10 ms ticks, so no scheduler or hardware-stall attribution is claimed.

Pinning is a verified Linux probe mechanism, not a portable default. Node's Worker API has no
affinity parameter. A production host can apply native thread placement under its own scheduler.
Worker caps, batching, singleton routing and shared arenas do not depend on affinity.

Final run: peak RSS 1699.129 MiB, minimum free RAM 24293.6 MiB, one-minute load 0 to 0.37. Source
archive SHA256 is `7390d5558f8c2b39d58152a52b2a8b33a31cdbfe545eecd1b4f394413cfbc634` and the raw
`affinity.jsonl` is `def380244cf05c12866462c091a1f8276980dcfa3b57575b8afa947d657521a8`. All 12
production source files and their built output matched that archive byte for byte when the run
was recorded (`results/source-manifest.json`). The repository was formatted with Prettier and
documented with TSDoc afterwards, which changed whitespace, import order and comments only. The
measured sources remain in each set's source archive, and the full gate passes on the formatted
tree.

---

## ☁️ Managed Cloudflare Deployment

### Capability Probe

`experiments/cloud/` holds the first deployed probe. Its bundled Wasm atomic control uses the
freestanding C build and compiles nothing at request time. Each deployed run was bounded to three
external requests, at most 57 Worker and Durable Object invocations and zero SQL or storage calls,
and nothing enabled a paid plan. Two measured runs used at most 114 invocations. The published
Free allowance is 100,000 Durable Object requests and 13,000 GB-s a day [6].

| Deployed mechanism                       | Observation                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------- |
| Ordinary byte RPC                        | exact independent copy: recipient 17 to 29, caller stays 17                 |
| Same-isolate SAB clone                   | bidirectional aliasing                                                      |
| Bundled C Wasm atomic control            | exact                                                                       |
| MessageChannel SAB                       | explicitly refused                                                          |
| SAB and shared Memory as RPC arguments   | unable to deserialize cloned data                                           |
| SAB and shared Memory as RPC returns     | unable to deserialize cloned data                                           |
| Ordinary Memory and MessagePort over RPC | clone or serialization refusal                                              |
| Eight CPU lanes                          | eight distinct module UUIDs, exact checksums, no co-residency observed      |
| Account cleanup                          | delete-class migration, then script deletion; resource lists equal baseline |

Corrected telemetry run `cfw-folio-6f050255` kept two measured rounds after one warmup. Coordinator
spans for K=1, 2, 4, 8 were 122.5, 67.5, 45 and 32.5 ms (medians), with eight-lane paired speedups
of 3.968x and 3.588x. The first run's 195.5 ms serial baseline and 4.775 to 5.405x ratios stay on
record; different runs are never combined into one matched speedup. Workers clocks freeze during
synchronous JS, so a lane's own `Date.now` delta is not CPU telemetry [7]. The tail captured 38 of
45 lane events and every incomplete row is marked. One complete eight-lane row used 127 ms of
platform CPU inside 31 ms of coordinator wall time (4.097 CPU over wall, 3.719 after subtracting one
millisecond per lane for resolution). Missing events are never invented. This shows CPU overlap and
says nothing about memory sharing.

The sanitized summary is `experiments/cloud/results-managed.json` and the local workerd control is
`experiments/cloud/results-local.json`. Raw tails, baselines and logs live in the ignored
`experiments/cloud/runs/`. Both successful runs restored the one pre-existing Worker and namespace
exactly.

### What Blocks Sharing on Managed Workers

At workerd release v1.20261019.1 (commit `781048bc05cb205c92e503c1062ef3266ab959b5`), JSG local
cloning keeps a `shared_ptr<v8::BackingStore>`. Worker RPC keeps serialized bytes and drops the
shared backing-store array, so the receiver has no matching handle. `MessageChannel` refuses
shared backing stores outright, and the `worker_threads` shim does not create an execution agent
[8][9][10][11]. The deployed failures agree with these source boundaries.

Three independent blockers follow. RPC loses the backing-store table. `MessagePort` rejects SAB and
only entangles ports inside one isolate. Managed Workers expose neither process-local placement nor
a scheduler for parallel agents over one allocation. Enabling `nodejs_compat` changes available
APIs and polyfills, and `worker_threads`, `vm`, `cluster`, `child_process` and `v8` stay stubs.
The Free and Paid plans show no difference in these semantics in anything measured here; the
published limits (128 MB per isolate, no threads) are the same for both.

| Route                                       | Physical sharing                                    | Required work                                                                                               |
| ------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Folio Node execution host                   | Between its co-located isolates                     | Transport, authorization, admission and lifetime exist; the consumer registers artifacts and bindings       |
| Self-hosted workerd arena channel           | Native building block identified, adapter not built | Retain handles in a process-local authenticated channel; add a separately scheduled isolate group           |
| Managed Workers with copied owners or pages | None                                                | Ownership, coherence, resumable guest accesses and a production adapter; never label copied pages zero-copy |

A native workerd adapter needs a tenant-scoped arena registry, an unforgeable membership
capability, same-process placement, retained backing-store lifetime, growth coordination,
cancellation and explicit physical and private accounting. It must reject remote and cross-tenant
attachments, and revocation stops new attachments while existing native references run down.
Managed JS cannot install this registry through the tested RPC interface. That is a missing host
capability, not evidence that V8 cannot share memory.

### Managed Coherent Backend

`src/managed.ts` with `src/frames.ts` (`@gmitch215/folio/managed`) runs entirely in managed Workers
and Durable Objects. The coordinator and its JSPI stack stay in a Durable Object. It sends bounded
binary region batches and a frozen memory snapshot to named lane objects, and validates results in
order. This is copied coherent memory, not shared memory. Neither route depends on Node
compatibility creating operating-system threads.

Final run `experiments/managed/runs/cfw-folio-managed-a627504d/`: all 39 rows pass (13 warmups,
26 measured). Every parallel row discovers 64 regions, has zero replay, native or transport
fallbacks, and matches the native scalar and all 131072 memory bytes. Two, four and eight lanes
report 2, 4 and 8 distinct module UUIDs in every measured row. JSPI is present and exercised by the
extracted coordinator.

| Transport                   | Two lanes | Four lanes | Eight lanes |
| --------------------------- | --------: | ---------: | ----------: |
| Batched RPC bytes           |  473.5 ms |   370.0 ms |    358.0 ms |
| Binary fetch                |  472.5 ms |   353.5 ms |    357.0 ms |
| Streamed binary fetch       |  537.5 ms |   398.5 ms |    360.0 ms |
| Persistent binary WebSocket |  453.0 ms |   381.0 ms |    357.5 ms |

Medians of two samples. Serial is 572.0 ms [570 to 574]. Each timed row includes preparation, lane
admission, a serial oracle and joined close, so these are end-to-end figures. The best paired
improvement is 1.618x (four-lane binary fetch). They are not isolated kernel speedups, no
aggregate CPU claim is made, and every raw sample and byte count stays in the result files.

The backend copies a whole frozen arena per lane batch, with a default snapshot limit of 32 MiB.
It has no distributed page ownership, residency leases or native memory larger than the owner's
budget. WebSocket events need `binaryType = 'arraybuffer'`; the default blob events produced
invalid frames and correctly triggered native fallback.

Earlier attempts stay in their own cleaned-up run directories. The first hit route propagation
(404) before any workload ran, which now has an unauthenticated readiness check ahead of the
protected call. The second finished three exact serial rows and then found the prepared pool gone
on a later RPC. The final `runPrepared` keeps preparation, execution and close in one owner
invocation, so nothing assumes in-memory state survives between independent calls. A cleanup
timeout was recovered with `experiments/cleanup.ts`, and account scripts and namespaces match
baseline.

### Browser Run

`experiments/browser/` serves a cross-origin-isolated page from a deployed Worker and drives it
through the Browser Run binding. Run `cfw-folio-browser-0e66d825` (STUDENT) passes cross-origin
isolation, eight distinct worker UUIDs, a 256 MiB shared Wasm attachment, 40000 native atomic
increments, bidirectional and cross-worker aliasing, an isolated copied-buffer control, growth and
zero fill. Creator termination is requested and surviving holders keep access; the browser API
gives no termination acknowledgement.

| Elapsed median (three samples) |      owner | one worker |       two |      four |     eight |
| ------------------------------ | ---------: | ---------: | --------: | --------: | --------: |
| Native kernel                  | 119.250 ms | 128.695 ms | 63.620 ms | 30.785 ms | 36.790 ms |

Four workers give 3.874x over the owner. The kernel partitions are explicit, so this proves the
memory and CPU mechanism and not automatic extraction. No native aggregate CPU meter exists; the
whole session reports 5257 ms and its page 2487.435 ms. Browser JSPI is absent, so the generalized
controller needs a fallback or another configuration before it can use this arena. A compiler-proved
countdown adapter without JSPI now bridges it for the guarded subset (Browser Automatic Extraction
Without JSPI). Account resources matched
baseline after cleanup. This result says nothing about ordinary Worker or Durable Object backing
allocations.

---

## 🌉 Execution Host and Portable Client

An edge Worker can keep its URL and stream a response from a Folio execution host. Sharing happens
inside that host, and the request and result cross a network transport. This moves execution and
does not merge Cloudflare isolate quotas.

`src/remote.ts` and `src/host.ts` (`@gmitch215/folio/remote` and `/host`) implement it. The client
uses fetch or service bindings, has no Node imports and compiles no Wasm. The host registers
trusted artifacts and export allowlists, creates real Folio groups, and exposes ordered run, read,
write and close commands. Number bit patterns, BigInts and void values have an explicit codec.
Object identity and executable JS stay at the host.

Each session has an unforgeable random capability and a monotonic sequence. An exact duplicate gets
its cached response, and conflicting duplicates and gaps are refused. Lost success and trap
responses are tested without replaying effects, and `retryPending()` recovers explicitly. The cache
is bounded and in memory, so it gives no exactly-once effects across host restarts. Authorization,
live groups, worker count, request, response, read and write bytes, argument count, idle expiry
and retained sessions are bounded, and disposal joins workers and pending effects before releasing
its admission slot.

Memory admission is an initial check of the accessible backing, including a hidden primary arena
exposed by the coordinator. It is not a hard V8 heap or growth quota: trusted artifact factories
enforce declared maxima, reserve snapshot and private overhead, and account for hidden
allocations.

`experiments/cloud/host-probe.ts` runs the portable module in stock workerd (Miniflare) with a
service binding to the authenticated Node host. Four distinct Folio threads execute the C entry,
all 131072 bytes match an untouched oracle, i64 and void results match, and eight host requests
create and dispose two groups with zero active groups at the end. Evidence:
`experiments/cloud/results-host-20261020.json` (workerd 1.20260815.1, Miniflare 5.20260815.0-alpha,
compatibility date 2026-08-22, Node 26.8.2), with the earlier `results-host-local.json`,
`results-host-local-v2.json` and `results-host-final.json` kept. The probe passes again on workerd
1.20261019.1 and Miniflare 5.20261019.0-beta (`results-host-consolidated.json`). This route is
tested in local stock workerd. A publicly deployed Worker to host endpoint and its network latency
are not measured.

---

## 🧩 API and Compatibility Evidence

The package root exports `Folio`, `prepare`, `suspending` and types. `/node`, `/compiler`,
`/remote`, `/host` and `/managed` are subpaths. Inputs may be source bytes, ArrayBuffer, a compiled
Module or a trusted `PreparedProgram`; a compiled Module keeps its native path because its bodies
cannot be inspected through reflection. Multiple memory imports bind by name, and ordinary wasm32
imported memories can be allocated from their original limits. Owned memory keeps its identity and
buffer semantics, and a coordinator plan can expose its single hidden arena through `memory`.

`run` owns automatic discovery and `runAll` is the lower-level ordered-call API. Reports carry
serial, speculative or native-shared mode, participating workers, region, replay and fallback
counts, a routing reason and optional timing. Generalized runs also report `extraction`,
`memoryMode` and `snapshotBytes`. `inspect(entry)` separates native guards, counted-loop plans and
control-flow plans. A serial report has zero participating workers even when singleton regions were
found and run at their owner.

For JSPI, `suspending(asyncHostImport)` wraps an import and `promising` lists the asynchronous
exports. Wrapping reference-returning exports would change an externref Promise's identity through
Promise assimilation, so they keep the native ABI. Numeric coercions happen once at the original
call site and host exceptions keep their identity. Concurrent runs are refused. Close joins worker
termination and outstanding JSPI calls; a suspended external operation may still need to finish.

Integrated checks cover compiler discovery, private locals and conditionals, scalar carry refusal,
dynamic conflicts, blind and partial writes, guard overlap, bounds and wrap, trap prefixes,
budgets, initialization, growth, imports, refs, async effects, numeric bit preservation and
cancellation. Import accessor order and receivers match native instantiation, and cross-realm
bytes, compiled modules and shared memory keep their native brands.

Real consumer artifacts were compared with original native instances:

| Artifact                          | Result                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| tinyimg 809,683-byte ABI 2 module | 14 create, fill, invert, size, destroy and free calls; every return and the complete 1 MiB final memory agree |
| gmux 4,303-byte core ABI 1 module | 10 queue, version and reset calls with imported table and globals; return sequence and entire memory agree    |

The generalized implementation repeats the comparisons in
`results/integration-generalized-final.json`. tinyimg image creation runs three regions on two
workers; fill finds 24576 singleton regions that stay local after the singleton routing fix; invert
stays native. No image speedup is claimed. The gmux queue stays serial through `runAll` with its
imported global and table state. This is artifact compatibility and observed extraction, not a full
consumer adapter. SHA256: tinyimg
`b6b52b8c2b9341191795d589d2bf8590f728539766c9914f900ae0fe96a914bb`, gmux core
`0a92cb8087557b71c763e5aa38c72d17b3cf47fafa67352150df30f2a1340a22`.

Two defects were caught in review before measurement: scalar carry was lost when an outlined local
was captured again on the next iteration, and an earlier queued trap could starve behind infinite
tail recursion. Both have dedicated regressions. tinyimg also exposed missing Binaryen feature flags
for sign-extension and saturating conversions.

### Extraction Coverage

| Case                                     | Current implementation                                                 | Extension that would raise coverage                                   |
| ---------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Admitted scalar CFG                      | Engine coordinator; nested loops, calls, switches, returns, tail calls | Larger region selection and alias guards                              |
| Inline memory kernels                    | Outlined with capture, remap, local-use and definite-assignment proofs | Full CFG liveness instead of conservative outside-use counts          |
| Scalar carry and reductions              | Original owner stack; independent surrounding regions still extract    | Future-valued scalars and proved scan or reduction transforms         |
| Used callee return                       | Coordinator runs the result dependency; inner regions may extract      | Def-use scheduling of independent later calls                         |
| Globals, tables, allocator, C stack, TLS | Kept at owner; joins before opaque state and effects                   | Owner capabilities, disjoint private stacks or tracked state slots    |
| SIMD, GC and refs, EH and longjmp        | Whole native function boundary                                         | Typed continuation and state lowering                                 |
| Memory 64 and multiple memories          | Original native module and supplied bindings                           | Wide address ABI and memory IDs in transaction sets                   |
| Irreversible host effects                | Join, run once at owner, resume the original stack                     | Consumer-specific effect routing; no generic rollback of external I/O |
| Direct and mutual recursion              | Original native owner; legacy tracking refuses it                      | Resource-aware continuation model                                     |
| Modules Binaryen cannot inspect          | Original native module                                                 | Another frontend                                                      |

An unrecognized feature is an analysis exclusion and never proof of a serial dependency; every
exclusion keeps a working native path. Polly [12], LLVM runtime alias guards [13] and NewAge [14]
remain relevant prior art without being dependencies. A next-input chain that depends on an
unpredictable external response keeps its order, and independent surrounding work can still
overlap. A memory recurrence may admit a proved scan; speculative replay alone need not speed it
up. The proof obligation for each region is captured scalar inputs, complete tracked effects,
ordered validation and observation barriers, exercised by finite differential tests and not by a
formal whole-compiler verification.

---

## 🧵 Browser Automatic Extraction Without JSPI

`BrowserFolio` (`@gmitch215/folio/browser`) accepts a precompiled original module and trusted
build-time `LoopPlan`/`NativePlan` metadata. One ordinary entry call supplies its address, count
and scalar arguments. The library derives partitions, proves complete byte footprints in bounds
and without wrap or cross-lane write overlap, dispatches them to module workers and joins before
returning. Workers share the original `WebAssembly.Memory`; no snapshot, transaction log, JSPI or
per-load message is used. A two-way atomic marker handshake verifies that every worker attached to
the same physical allocation and restores the marker. Worker instantiation requires reason-free,
initialization-free compiler admission. Other modules and failed guards use the original owner
entry. The caller must exclude external memory mutation during open and execution.

The new path was deployed on the **FREE** account in run `cfw-folio-browser-72ad9035` on
2026-10-20. Chromium reported **no JSPI**, cross-origin isolation and hardware concurrency 4.
The unchanged `program(address, 67, rounds)` call automatically used 2, 4 and 8 workers over a
**268,435,456-byte** physical allocation. Every return and every byte matched the native owner in
all 20 warmup/measured calls; growth to **268,500,992 bytes** also passed. All four pools closed.
The browser session took 22.008 seconds; the account returned to its baseline of zero Workers and
zero Durable Object namespaces. Raw run files remain ignored under `experiments/browser/runs/`;
the sanitized evidence is `experiments/browser/results-free-extraction-20261020.json`, generated
by `experiments/browser/analyze-extraction.ts` from the retained run.

Three retained samples per arm give exploratory medians of 62.915 ms for the native owner,
61.650 ms for automatic one, 32.620 ms for two, 20.540 ms for four and 18.240 ms for eight:
**1.929x / 3.063x / 3.449x** against the native owner. The two-worker arm also contains a
98.035 ms sample, retained in full. These are wall-time measurements on one synthetic kernel;
they establish neither aggregate CPU reduction, energy savings nor consumer application speedup.
The local Chromium control independently passed with both JSPI entry points explicitly removed
before library load (`results/browser-extraction-local-no-jspi.json`).

This closes counted-loop extraction without JSPI. Arbitrary CFG regions still need explicit
continuation lowering or a suspending coordinator. A worker failure after native direct writes
joins the other workers and invalidates the pool; recovery needs a checkpoint. It must not silently
replay an arena that may already contain partial writes. `close()` joins finite work before
termination; it does not promise preemption of an arbitrary infinite program.

---

## 🧑‍💻 Consumer Boundaries

### PHP Preparation Blocker

The shipping 13,401,751-byte PHP artifact has SHA256
`95447d3dd001ccbdbb392a6f5f64210380712a76cf22b00487333277414ba6e4`. The failure came from Folio's
per-access helpers. It was not a million functions in PHP. Reproduction with the unchanged
extractor hit V8's one-million defined-function limit [17]. Imports explain the difference between
Binaryen's total and the exception:

| Module                | Imported functions | Defined functions | Total functions |
| --------------------- | -----------------: | ----------------: | --------------: |
| Original PHP          |                103 |            12,378 |          12,481 |
| Previous coordinator  |             57,143 |         1,258,580 |       1,315,723 |
| Corrected coordinator |             57,143 |           191,925 |         249,068 |
| Extracted worker      |                  0 |           114,076 |         114,076 |
| Tracked worker        |                  7 |           114,077 |         114,084 |

`extract.ts` now interns load/store barrier helpers by operand types and every non-operand opcode
attribute: width, sign, offset, alignment, atomic order and result type. Only one admitted memory
is involved. Operand evaluation order, draining, native traps and bit values stay unchanged.
Generated helpers fall from **1,132,678 to 66,023**, including **7,815** memory-operation variants.
Both versions outline 56,486 functions and discover 57,038 regions. The corrected coordinator has
2,591 admitted entries and 789 analysis diagnostics; reducing instrumentation kept the regions.
Regression tests compare whole memory, observed values, opcode variants and out-of-bounds traps.

A second defect appeared during worker preparation: the compiler scanned every export for every
function. A live stack sample found repeated export-name decoding; that run was stopped and is not
a timing result. `compiler.ts` now indexes exports once by function, preserving every alias and
prototype-like name. Corrected instrumented preparation completes in **116.242 seconds** in one
local Node 26.8.2 run. All three generated binaries validate in V8. This is a completion observation,
not a measured preparation speedup. The legacy path still reports host/non-memory imports, while
the generalized control plan is present. Evidence: `results/php-preparation-before-20261020.json`,
`results/php-preparation-20261020.json` and `scripts/probe/php-preparation.ts`. Binary validation
alone does not establish boot or render.

### PHP Boot and Uncached Drupal Render

`results/php-render-20261020.json` records a local differential using drupflare's existing
`scripts/measure/abi-speed.ts` interpreter factory seam, tuned PHP glue, `INTERPRETER_MEMORY`,
`mountDrupalLazy`, `mountDriver`, `SiteDurableObject.installBridge`, boundary codec, ten boot shim
fragments, `BOOT_KERNEL` and `renderPage`. Its encoded SQL asset chunks seed Node SQLite through
the existing bridge. The owner keeps initialization and synchronous callbacks on raw exports;
only the existing Promise-shaped `pib_run` request enters `Folio.run()`. This changes no callback
to an asynchronous ABI.

Two defects appeared only when executing the real consumer. Binaryen moved PHP's memory import
ahead of its original 103 function imports, so the runtime correctly refused optimized
instantiation. `src/import-order.ts` now restores observable original lookup order while preserving
the relative order of every Wasm index-space kind, including generated imports. An incompatible
per-kind change is rejected. Getter-order and call-index differential tests cover this fix; the
runtime binding-order guard remains. The next attempt exhausted a 4 GiB JS heap before boot:
the import proxy rebuilt all 57,038 internal region bindings per namespace lookup. `node.ts` now
caches only Folio's own namespace once. Caller namespace effects remain uncached. A regression
counts exactly one suspension wrapper per region plus the two join/poll wrappers.

With both fixes, the actual prepared coordinator admits `pib_run` and passes:

| Observation                                      | Native and Folio                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| PHP boot                                         | PHP 8.5.2, 64-bit integers                                                          |
| Exception continuation                           | Expected caught PHP exception                                                       |
| Drupal kernel                                    | `ok=true`, database present                                                         |
| Real anonymous `/` render                        | HTTP 200, 17,699 bytes, no cookies                                                  |
| Cache state                                      | `page=MISS`, `dynamic_page_cache=MISS`                                              |
| Local SQL observations                           | 268 logical calls, 218 rows returned, 91 rows changed                               |
| Ordered SQL statement shapes, including counters | 804 statements; identical SHA256                                                    |
| Lazy ROM                                         | 11,674 files mounted; 1,844 files / 10,371,131 bytes materialized; 115 driver files |
| PHP memory after render                          | 86,638,592 bytes                                                                    |

HTML matches byte for byte after replacing only the 64 hex digits of the per-render Views DOM
nonce and `user.permissionsHash`. The raw HTML differs at those inputs. The normalized hash is
`5b6c9190cc1769951cdd60070ca6ed7eab539e493a78b1df19a3a6f78d2da2bc`. Two native-only renders also
differ byte for byte and agree after the same normalization, so those two fields vary between any
two renders and say nothing about Folio. Ordered SQL statement-shape
hash is `3055da9e6fbe632a9efaedcd6c522aa83adaf4a1325db1ba1d5a2ef8d1ad7400`. This compares
statement shapes/order and row counters, not every bound value or the complete final database.

The run uses the prepared coordinator, not the rejected original-module fallback. All three
top-level calls report control-flow extraction, one region, **zero dispatched workers**, zero
replays/fallbacks and `single-region`. Two worker threads were admitted and joined at cleanup;
their presence does not prove parallel PHP execution. The ordinary PHP heap is not proved
physically shared, and no PHP speedup, deployed Thunder capacity or exhaustive callback/longjmp
coverage is claimed. This closes actual local boot/render compatibility. Larger useful regions,
consumer effects validation and a shared-heap or paged-memory build remain the route to acceleration.

The harness is `scripts/probe/php-render.ts`, with `FOLIO_CONSUMER` naming a drupflare worker
checkout. A rerun from the repository in both modes reproduced the recorded 200 status, 17,699
bytes, `MISS` and `MISS` caches, zero dispatched workers, and the same ordered SQL statement-shape
hash. Preparing the module inside that rerun takes about two minutes and is cached in `build/`.
The record holds no timing comparison, and one uncontrolled rerun is not one.

### gmux Coverage and the Process Boundary

`scripts/probe/artifact-coverage.ts` collects `inspect()` from actual gmux artifacts. `automatic`
means an admitted static plan; it does not measure dynamic coverage or guarantee concurrency.
None has a native direct-write guard.

| Artifact                       |  Bytes | Function exports | Automatic entries | Execution checked                                     |
| ------------------------------ | -----: | ---------------: | ----------------: | ----------------------------------------------------- |
| Machine core ABI1              |  4,303 |               12 |                 6 | Earlier queue differential still applies              |
| Katybug emitted region         | 68,467 |                1 |                 0 | Import binding and inspection only                    |
| wasm32-linux ABI process probe | 60,522 |              188 |                63 | Three libc calls; full 8 MiB memory and returns exact |

`results/gmux-artifact-coverage-20261020.json` records hashes, every exported function's inspection,
imports and run reports. Both process `memset` calls execute four speculative regions on two
workers; `memcpy` is serial. Unexpected syscall imports throw. These are real process-memory
functions, not a Linux boot, process main, syscall test or speedup measurement. The lifted module's
host access helpers, mutable GOT global and i64 result leave its sole export native.

The adapter seam is gmux's `Machine.instantiateUser()` and `userEnv()` in
`src/worker/machine/machine.ts`, plus dynamic-loader instance construction. They own memory, stack
pointer, TLS, relocation bases, tables, syscall callbacks, mapping guards and JSPI runner lifetime.
Keep those capabilities at the authoritative machine. The first distributed integration should be
an independent-process capsule: private memory, immutable filesystem generations, local reads,
buffered effects and one validated effect-log publication. Changed generations discard speculative
effects before irreversible output. Pipes, signals, credentials, fd offsets, partial I/O and exit
status need ordered owner acknowledgements. Queue compatibility alone does not implement this;
forwarding every syscall would add a network round trip to the hottest boundary.

Shared writable mappings follow process capsules. A lease includes permissions and mapping
generation; unmap, mprotect, fork/exec and growth invalidate its views. A direct native span needs
complete residency and bounds proofs with no remap, yield or escaping physical view. Atomics and
futexes require owner serialization or real shared backing; copied leases do not supply coherence.
These hooks belong in gmux. Neither consumer depends on the other.

### Speedup Search on PHP and Other Consumers

Recorded 2026-10-20 on an Apple M2 Pro laptop with 12 hardware threads, Node 26.8.2. This is not the
Paisley Park rig, and the machine was not quiet: the load average had a median of 3.7 during the
ten-workload set, because the author's smoke runs overlapped it. Every figure comes from alternating
rounds in one process (or, for the Drupal render, one process per sample), so each speedup is a
native time divided by the Folio time of the same round. Wall time is `performance.now()` around the
call, and CPU is `process.cpuUsage()` over all threads. Raw rows and summaries are in
`results/20261020-php/` and `results/20261020-consumers/`; the harness is `scripts/probe/consumer.ts`.

**PHP userland, shipping artifact.** Ten workloads run through `pib_run` on an artifact whose
SHA256 is `95447d3d...ba6e4`, in a native instance and in Folio pools of 1, 2, 4 and 8 workers.
Twenty paired rounds each, after two warmups; every output digest equals the native one.

| Workload (native median)                           | Speedup at 2 / 4 / 8 workers (median) | Workers dispatched | Regions enqueued |
| -------------------------------------------------- | ------------------------------------- | -----------------: | ---------------: |
| 3000 sha256 of 8 KiB (211.6 ms)                    | 1.001 / 1.003 / 1.000                 |                  0 |                1 |
| 6000 md5 + crc32 (308.5 ms)                        | 1.000 / 1.001 / 0.998                 |                  0 |                1 |
| 12 bcrypt, cost 8 (723.6 ms)                       | 1.011 / 1.009 / 1.010                 |                  0 |                1 |
| pbkdf2-sha256, 40000 rounds (194.4 ms)             | 0.992 / 0.995 / 0.991                 |                  0 |                1 |
| serialize, json round trip (96.2 ms)               | 0.970 / 0.971 / 0.974                 |                  0 |                1 |
| usort and sort, 30000 ints (79.7 ms)               | 0.961 / 0.963 / 0.972                 |                  0 |                1 |
| string functions on 4 MB (97.3 ms)                 | 1.006 / 1.005 / 1.001                 |                  0 |                1 |
| preg_match_all, preg_replace_callback (53.2 ms)    | 0.987 / 0.984 / 0.979                 |                  0 |                1 |
| array_map, array_filter, 300000 (68.9 ms)          | 0.952 / 0.949 / 0.945                 |                  0 |                1 |
| levenshtein and similar_text, 400 pairs (135.2 ms) | 0.973 / 0.974 / 0.973                 |                  0 |                1 |
| Drupal uncached `/`, n=10 (790.1 ms)               | 0.895 / not run / 0.869               |                  0 |                1 |

The one-worker arm, which runs the original module, stays within 0.990 to 1.002. CPU ratios sit at
0.99 to 1.06 for the userland rows. The Drupal row's CPU ratio is 1.68 and 1.71, and it is process
CPU between two stages, so it includes V8's background compilation of the 31 MB coordinator; the
split between compilation and execution is not measured. **No PHP speedup is shown.**

**Where the time goes.** A V8 CPU profile of the native render (one run, 1700.5 ms sampled, 802.8 ms
in wasm) is flat: `lex_scan` 7.5% of wasm time, `zendparse` 5.4%, `execute_ex` 3.4%, and 28
functions cover half of it. `results/20261020-php/census-php.json` gives each of the 12,378 defined
functions the first rule that keeps it out of a worker region:

| First blocking rule                              | Functions |
| ------------------------------------------------ | --------: |
| global access (all but 78 are the stack pointer) |     9,183 |
| `call_indirect`                                  |     2,110 |
| calls an impure function                         |       463 |
| calls an import                                  |        54 |
| pure (usable as a region)                        |       567 |

Allowing the stack pointer global would make 2,698 functions pure, 654 of them with a loop and a
store. Joining the profile to that census gives the share of sampled wasm time by rule: functions
that contain `call_indirect` 44.2%, other blocked functions 40.0%, pure if the stack pointer were
allowed 6.7%, calls an import or an impure function 4.9%, pure today 3.9%. If every function in the
pure-if-stack-pointer and pure-today groups (6.7% plus 3.9%) ran on workers at no cost, the ceiling
would be 1 / (1 - 0.106) = 1.12x. That bound comes from one profile of one render recorded on the
Mac, and it assumes the pure share runs fully in parallel, which needs independent calls and not
only pure functions.

**Why almost no region runs.** `lower()` in `src/extract.ts` sets the `serial` global to 1 around every
call to a non-controller function and every `call_indirect`, so a region reached through the PHP VM's
function pointers runs at its owner. A boot and an uncached render enqueue three regions in total,
all `__folio_region_328`, and each `pib_run` enqueues one. A flush also needs two regions before a
join, and the coordinator joins before every load, store and global access. Counters on three
workloads show 35 barrier crossings, one enqueue and two polls per request, so JSPI crossings do not
explain the 0.95x to 0.98x rows. Instrumentation cost in the larger module is the remaining
candidate and is not isolated.

**Mechanisms tried and closed, with the measurement:**

| Mechanism                                             | Measurement                            | Result                                                                                                                                    |
| ----------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Existing region extraction on PHP builtins            | ten workloads, n=20, 2/4/8 workers     | 0 workers dispatched, 0.945x to 1.011x                                                                                                    |
| Host `runAll` over exported PHP hash updates          | export membership of the worker module | `PHP_SHA256Update`, `PHP_MD5Update`, `PHP_CRC32Update` and `PHP_XXH64Update` are not among the 139 pure exports, so `runAll` refuses them |
| Offloading functions that need only the stack pointer | census joined to the profile           | ceiling 1.12x on this render, at no cost                                                                                                  |

These close mechanisms, not the objective. Untested mechanisms from the 20-row survey in
`scratchpad/agent-results/v1-speedup-survey.md` stay open: admitting `call_indirect` to pure targets
through a table-membership check (44.2% of sampled wasm time sits in functions that contain one),
private stack slices per region, speculative controller loads with replay, and a shared heap that
avoids the snapshot copy. Request-level splitting across PHP instances is outside Folio.

**Other consumers, before static admission.** The same harness, 20 pairs per arm, 1/2/4/8 workers, whole memory and every
return compared in every round:

| Consumer and case                                             | Native median | Speedup at 2 / 4 / 8        | CPU ratio         | Dispatch                       |
| ------------------------------------------------------------- | ------------: | --------------------------- | ----------------- | ------------------------------ |
| compute kernel (control, not a consumer)                      |      234.8 ms | 1.91 / 3.77 / 7.32          | 1.04 to 1.08      | 64 regions, workers as asked   |
| tinyimg 1024x1024 RGBA, `fill_rectangle`                      |       2.02 ms | 0.0018 for all              | 555x              | 64,576 regions, 0 workers      |
| tinyimg `replace_color`                                       |       2.58 ms | 0.0031                      | 318x              | 16,192 regions, 0 workers      |
| tinyimg `fill_ellipse`                                        |       1.44 ms | 0.0017                      | 590x              | 46,016 regions, 0 workers      |
| tinyimg `opacity`                                             |       0.66 ms | 0.0025                      | 405x              | 0 regions, 0 workers           |
| tinyimg `convert_channels`                                    |       6.85 ms | 0.0099                      | 102x              | 32,320 regions, 0 workers      |
| tinyimg `crop_circle`                                         |       0.90 ms | 0.0020                      | 494x              | 18,307 regions, 2 workers      |
| tinyimg invert, sepia, saturation, blur, sobel, resize, shear |    8 to 38 ms | 0.96 to 1.00                | 1.0               | no plan, serial                |
| gmux process artifact `memset` 16 MiB                         |       0.43 ms | 0.0029                      | 345x              | 4 regions, 2 workers           |
| gmux process artifact `memcpy` 16 MiB                         |       0.68 ms | 0.0026                      | 387x              | 0 regions                      |
| gmux core ready queue, 302 calls                              |      0.008 ms | 0.17 batch, 0.024 per call  | 5.6x, 38x         | serial                         |
| serial recurrence, 500,000 iterations                         |       0.51 ms | 0.00023 / 0.00033 / 0.00031 | 7,141x to 14,892x | 500,000 regions, 2/4/8 workers |

The kernel control shows that the harness sees a win when one exists. The other rows are slowdowns
of two to four orders of magnitude, and no consumer case shows a speedup. Two measured causes: a
region that holds a few instructions costs more to enqueue and join than to run (the recurrence's
500,000 store regions), and a coordinator that finds no region still pays a JSPI barrier before
every load and store. `tinyimg opacity` made 4.19 million barrier crossings per call with no region,
about 64 ns each. For the serial rows the CPU ratio equals the inverse speedup, so the extra time
is computation on the coordinator thread and not waiting.

**Superseded.** The lone-region streak heuristic (`Coordinator.bypass()` and `own()`) that this section
first recorded is deleted. Static admission leaves such regions at the owner before the run starts,
and a paired run of the heuristic against its absence on a lone-region workload (n=20, 2 and 8
workers, `results/20261020-regress/bypass-decision.summary.json`) showed the same 1.003 median speedup
and zero workers dispatched either way.

### Static Admission and the Native Fallback

Recorded 2026-10-20 on the same Apple M2 Pro (12 hardware threads, Node 26.8.2), not the rig.
The machine carried background load: the median load average of each main set was 2.9 to 4.7, and 5.6 and 8.5 in
the two reruns, whose 8-worker arms raise the average themselves. Every row below is
an alternating round in one process of the native instance, the archived build from before this change
(`results/20261020-regress/old-build-src.tar.gz`, arms `old-N`) and the current build (arms
`folio-N`), with the whole memory and every return compared in every round. Raw samples and
summaries are in `results/20261020-regress/`; the harness is `scripts/probe/consumer.ts` with
`FOLIO_OLD_BUILD=1`.

**Two mechanisms, measured on the old build.** The tinyimg `opacity` call made 4,194,822 barrier
crossings and 524,289 poll crossings with an empty queue. Replacing the barrier and poll imports in the
same module by plain JavaScript no-ops cost 14.1 ms of the 251 ms (the helper call and one Wasm to JS
call, 5.6%); making them `WebAssembly.Suspending` imports that return undefined cost the rest, about
53 ns per crossing (94%), against 0.63 ms native. The serial recurrence enqueued 500,000 regions of one
store each: 1.7 to 2.8 us per region for queueing, batching and validation against about 1 ns of work.
These are different problems and have different fixes.

**Changes.**

- `prepare()` estimates every candidate region in instruction units: nodes weighted by trip count, calls
  included, minus 3,600 units per tracked load or store. A loop bounded by a constant uses it, a loop
  bounded by an untouched parameter or a countdown from one becomes a term in that parameter, and any
  other loop uses `assumedTripCount` (1,000). A region below `minimumRegionWork` (200,000) is not a region.
  A parameter-bounded one is compared with the threshold at each call by a generated `__folio_dispatch_N`
  (a few f64 operations) and runs at the owner when it falls short. Both options are documented in
  `AdmissionOptions`; `minimumRegionWork: 0` admits every pure region, which the unit tests use for their
  small fixtures.
- The generated barrier and poll read an imported `pending` global and cross into JSPI only while it is
  1. The coordinator raises it when a region is queued and lowers it only after the queue is empty and the
     last flush has resolved and committed, so a stale value can only cost an empty crossing. Three
     mutations of that logic each fail a test (`tests/unit/coordinator.test.ts`, `control-flow.test.ts`).
- When no region is admitted, or none has a call site, `prepare()` returns no control plan and `Folio`
  binds the original module with no Suspending imports and no coordinator. The decision is made once at
  prepare time; a unit test counts zero coordinator calls and checks the result against a raw instance.
- Cost of the admission check on an admitted region: under 10 ns per call, against 2.5 to 3.9 us of
  dispatch. A lone admitted region still pays one JSPI round trip and a native run at the owner.

**Calibration** (`scripts/probe/admission-calibration.ts`, 31 synthetic cells, 20 pairs each, every region
admitted with `minimumRegionWork: 0`; fitted by `scripts/analyze/admission.ts`). Three runs (the first two at load 3.5 to 13.8 and 5 to 6.7, the last starting at 2) agree: native speed 0.1945 ns per estimated unit; per-region overhead 3.85 us at
two workers and 2.51 us at eight; 0.65 us per tracked access, or 3,361 units (3,607 and 3,376 in the other
runs; the constant is 3,600). Break-even, where overhead plus native time over workers equals native time:
39.6k units at two workers and 14.7k at eight. Measured paired speedup by region size:

| Region work (units, native time) | 2 workers (median, min) | 8 workers (median, min) |
| -------------------------------- | ----------------------- | ----------------------- |
| 13,315 (2.5 us)                  | 0.50, 0.38              | 0.72, 0.52              |
| 53,251 (10 us)                   | 1.09, 0.99              | 2.32, 1.75              |
| 212,995 (41 us)                  | 1.65, 1.55              | 4.77, 3.48              |
| 851,971 (166 us)                 | 1.88, 1.84              | 6.57, 5.85              |
| 3,407,875 (667 us)               | 1.96, 1.93              | 7.53, 5.53              |

The first default, 500,000, was the point where overhead is at most 5% of a region's native time (396k to
406k across the three runs, rounded up). The data shows that rule forfeits profit: a 41 us region runs
4.8x faster at eight workers. The default is now 200,000, the smallest calibrated size whose two-worker
speedup exceeds 1.5x in every sample. Sites against that line (`admission-sites.jsonl`, net units):
kernel control `program` 25.0M (125x over); tinyimg's largest candidate 7,004 and every tinyimg span 7
to 14 nodes (28x under); the serial recurrence's store span 3 units and 1 access (net negative) and its
loop function net -3.59M; gmux core and ABI at most 47. Region sizes between break-even and 200,000
stay native, which gives up speedup for regions of 15k to 200k units that are independent. The estimate
sums both arms of an `if` and counts a call to a non-region function as 2 units, so it can err either
way. It is a policy calibrated on one machine and one instruction mix.

**Before and after.** Native median, then speedup and CPU ratio (Folio CPU over native CPU) at 2 and 8
workers, median over n=20 rounds unless noted. `old` is the archived build, `new` the current one.

| Workload                                 |          Native | Old 2 / 8 workers                    | New 2 / 8 workers             | New p95, max (8 workers) |
| ---------------------------------------- | --------------: | ------------------------------------ | ----------------------------- | ------------------------ |
| kernel control, n=40                     |          342 ms | 1.95 / 7.41 (CPU 1.02/1.03)          | 1.99 / 7.48 (1.00/1.02)       | 61 ms, 79 ms             |
| serial recurrence, 500k                  |         0.70 ms | 0.00023 / 0.00033 (6,908x / 13,689x) | 0.963 / 0.969 (1.04)          | 0.76 ms, 0.77 ms         |
| tinyimg `fill_rectangle`                 |         2.85 ms | 0.0018 / 0.0018 (557x)               | 1.003 / 1.005 (1.00)          | 3.00 ms, 3.03 ms         |
| tinyimg `replace_color`                  |         3.68 ms | 0.0032 / 0.0032 (317x)               | 0.998 / 0.993 (1.00)          | 3.85 ms, 15.1 ms         |
| tinyimg `fill_ellipse`                   |         2.13 ms | 0.0017 / 0.0017 (578x)               | 0.998 / 0.996 (1.00)          | 2.30 ms, 3.89 ms         |
| tinyimg `opacity`                        |         0.95 ms | 0.0025 / 0.0025 (403x)               | 0.989 / 0.999 (1.02)          | 1.02 ms, 1.03 ms         |
| tinyimg `convert_channels`               |         9.78 ms | 0.0098 / 0.0099 (102x)               | 0.999 / 0.997 (1.00)          | 10.1 ms, 11.6 ms         |
| tinyimg `crop_circle`                    |         1.34 ms | 0.0021 / 0.0021 (487x)               | 0.985 / 0.992 (1.02)          | 2.30 ms, 3.72 ms         |
| tinyimg, seven other cases               |     12 to 54 ms | 0.96 to 1.00                         | 0.995 to 1.006 (1.0)          | in the summary           |
| gmux ABI `memset`, `memcpy`, chain, n=60 | 0.40 to 0.67 ms | 0.003 to 0.008 (180x to 344x)        | 0.968 to 1.009 (1.01 to 1.04) | in the summary           |
| gmux core ready queue, 302 calls         |        0.010 ms | 0.024 per call (37x)                 | 0.052 per call (17.6x)        | 0.28 ms, 0.35 ms         |
| 10 PHP workloads                         |  79 to 1,062 ms | 0.971 to 1.020                       | 0.992 to 1.030 (1.0)          | in the summary           |
| Drupal uncached render, n=10             |        1,174 ms | 0.905 / 0.911 (1.63x)                | 1.016 / 0.996 (1.02)          | 1,237 ms, 1,237 ms       |

The gmux ABI row comes from `gmux-abi-b.jsonl`, 60 pairs at 2 and 8 workers without old arms: the first
n=20 set (`gmux-abi.jsonl`) had a native median of 0.63 ms and a native spread of 0.7 to 19.8 ms while the
old arms churned the same 16 MiB, and its one 152 ms folio-2 sample had 24 ms of CPU, so it was a stall and
not work. The PHP and Drupal rows run the original module: no PHP region reaches the threshold, so
these are untouched-native routes and **not a PHP speedup**. The spread of the paired speedup (minimum to maximum) is in each summary. Its extremes are single rounds: 0.53 for `serialize-roundtrip` at eight workers, and the tinyimg and gmux maxima come from slow native samples. The kernel control reaches 7.48 against 7.41
for the old build (n=40, old over new wall time 1.009 at eight workers, range 0.741 to 2.547). The
first n=20 set read 6.82 against 7.36 (ratio 0.983, range 0.805 to 1.234); load there was lower and the
eight-worker arms are the noisiest, so the rerun, not either set alone, is the control. The two-worker
and four-worker ratios are 1.02 and 1.03 in both sets.

**Acceptance (at most 5% median warm overhead on nonparallel work).** Met by every tinyimg case, the
gmux ABI calls, the serial recurrence (3.1% to 3.7%), the lone-region kernel (0.987 and 0.991 at n=40; a
first n=20 set read 0.949 at eight workers and 0.969 at two, and the rerun does not reproduce it), the ten PHP
workloads and the Drupal render. Missed: **gmux core ready queue**, 302 calls of about 26 ns each,
where `Folio.run` itself adds about 0.65 us per call (0.20 ms against 0.010 ms for the 302 calls), so
0.052x of native. The admission path adds nothing there (0 workers, 0 regions), the cost fell from 37x to 17.6x of
native CPU. `Folio.runAll` over the same calls reads 0.17x. No other workload misses.

### Independent PHP Requests and the Drupal Render Breakdown

Recorded 2026-10-20 on Paisley Park (Ryzen 9 9900X, Node 26.10.0, governor `powersave`, cpus 2 to 11
under `nice 19`, ten physical cores for up to eight worker threads plus the main thread and V8's
compile threads), plus one Mac set that is labeled as the Mac. Raw rows, summaries and the machine
state are in `results/20261020-phpparallel/`; the instruments are `scripts/probe/php-contexts.ts`,
`php-concurrent.ts` and `drupal-breakdown.ts`. This is level A of direction.md (concurrent
requests) and the level C breakdown. It says nothing about parallel work inside one request.

**Design.** A context is a worker thread with its own PHP instance (private Wasm memory, heap,
Emscripten filesystem). Only the compiled `WebAssembly.Module` crosses threads. A Drupal context
also gets its own in-memory SQLite database loaded from the read-only seed files, and its own lazy
ROM mount over the read-only `drupal-pf` layer, so two renders cannot see each other's writes or
cache entries. The four arms are native serial (one instance, requests one after another), native
concurrent (one request per instance, released together), Folio serial and Folio concurrent. The
Folio arms open the same module through `Folio.open` with the current admit plan. That plan has no
region (`no region reached 200000 net work`), so Folio binds the original module with no
coordinator and no workers: the Folio arms run untouched native PHP by construction. Each round
runs every width and arm once in rotating order. All output digests are equal across arms and
rounds (the Drupal digest is the wave 1 value after the same two-field normalization).

**CPU-heavy read-only endpoints** (Paisley Park, n=20 rounds per cell, 960 samples; every cell
records load, per-request latency, per-thread CPU, process CPU and in-thread intervals). Scaling is
the native serial wall time of N requests over the wall time of N concurrent requests, per round;
the spread is the minimum over rounds.

| Endpoint (one request)       | Instances | Native scaling (median, min) | Folio scaling (median) | Folio over native concurrent wall (median; min, max) | Throughput native concurrent | p95 latency, concurrent |
| ---------------------------- | --------: | ---------------------------: | ---------------------: | ---------------------------------------------------: | ---------------------------: | ----------------------: |
| `sha256-batch`, 95 ms        |         2 |                  1.99 (1.90) |                   2.00 |                                    1.00 (0.96, 1.05) |                       20.9/s |                   96 ms |
|                              |         4 |                  3.96 (3.83) |                   3.94 |                                    1.00 (0.97, 1.03) |                       41.7/s |                   96 ms |
|                              |         8 |                  7.72 (6.48) |                   7.69 |                                    1.00 (0.83, 1.03) |                       81.7/s |                  100 ms |
| `serialize-roundtrip`, 54 ms |         8 |                  6.70 (6.11) |                   6.79 |                                    1.01 (0.90, 1.45) |                      125.1/s |                   64 ms |
| `preg-text`, 33 ms           |         8 |                  5.12 (4.05) |                   5.67 |                                    1.01 (0.54, 1.46) |                      154.6/s |                   53 ms |

The remaining cells (widths 1, 2 and 4 of the other two endpoints) are in `cpu-rig.summary.json`.
Aggregate thread CPU of eight concurrent requests against eight serial ones is 1.00 for
`sha256-batch`, 1.17 native and 1.11 Folio for `serialize-roundtrip`, and 1.04 for `preg-text`, so
the lost scaling there is per-request CPU growth (shared cache and memory, a `powersave` governor)
and tail stalls, not idle time. Time with two or more instances active was a median 99% of the longest request's service time in
the 360 concurrent cells of this set (5th percentile 96%, minimum 84%) and 99.7% in the 60 Drupal
cells (minimum 92%), measured from timestamps taken inside each thread, so the instances ran
PHP-runtime code at the same time. Serial arms show 1.00 scaling at
every width, which is the control.

**Drupal anonymous render** (n=10 rounds, 160 samples; each cell opens fresh contexts, so every
request is an uncached render, 200, 17,699 bytes, MISS on both Drupal caches). Open time of a
context is 287 ms median (SQLite seed 31 ms, PHP boot 15 to 25 ms, kernel boot 175 to 214 ms) and
is not in the render figures.

| Instances | Native serial throughput | Native concurrent throughput | Native scaling (median, min) | Folio scaling (median) | Folio over native concurrent wall (median; min, max) | p50 / p95 latency, native concurrent | Aggregate thread CPU, concurrent over serial |
| --------: | -----------------------: | ---------------------------: | ---------------------------: | ---------------------: | ---------------------------------------------------: | -----------------------------------: | -------------------------------------------: |
|         1 |                   1.95/s |                       1.95/s |                  1.00 (0.98) |                   1.00 |                                    1.00 (0.99, 1.01) |                         512 / 518 ms |                                         1.00 |
|         2 |                   1.96/s |                       3.83/s |                  1.96 (1.93) |                   1.96 |                                    1.00 (0.97, 1.01) |                         521 / 527 ms |                                         1.02 |
|         4 |                   1.95/s |                       7.55/s |                  3.91 (3.78) |                   3.83 |                                    1.02 (0.99, 1.13) |                         528 / 538 ms |                                         1.03 |
|         8 |                   1.93/s |                      13.67/s |                  7.06 (6.69) |                   7.11 |                                    1.00 (0.92, 1.08) |                         559 / 592 ms |                                         1.05 |

**Memory.** One process per measurement (`memory-rig.jsonl`). Resident set growth per extra
context, from the one-context and eight-context runs: about 57 MB native and 59 MB Folio for a
plain PHP context (a 64 MiB Wasm memory, of which a fraction is touched), and about 256 MB native
and 248 MB Folio for a Drupal context (86.6 MB Wasm memory after a render, the SQLite database, the
inflated ROM files at about 10 MB, V8 heap and per-thread compiler state). Eight Drupal contexts
reach 2.2 GB after one render. The shared artifacts are the compiled module and the read-only seed
and ROM files; nothing is copied or snapshotted between contexts.

**What this shows.** Independent PHP requests on private instances scale to 7.1x at eight instances
for the Drupal render and 5.1x to 7.7x for CPU-heavy endpoints, with tail latency 14% above the
single-request latency at eight for Drupal. Folio adds nothing to that. The Folio arms are within a
median of 1.00 of the native arms in every cell and the spread is noise (the largest ratios,
`preg-text` at eight, run 0.54 to 1.46 in single rounds because eight workers leave two cores for
the main thread and V8's compile threads). Folio cannot take credit for this scaling and it does not
make a request faster: the Folio route here is the original module. For drupflare this is the
request-level path. It needs no Folio.

**Where the 790 ms render goes** (level C, `drupal-breakdown.ts`, 10 fresh processes per arm, five
contexts each, instance 0 cold and instances 2 to 4 warm; the cold render is what one request pays
in a fresh process, the warm one is what a long-lived isolate pays). `phpExecutionMs` is render wall
time minus SQL and ROM inflate and so includes the Wasm interpreter running Drupal's PHP, the host
imports it calls and the filesystem shims.

| Part of one uncached render                             |     Paisley Park cold (n=10) | Paisley Park warm (n=30) |  Mac M2 Pro cold |  Mac M2 Pro warm |
| ------------------------------------------------------- | ---------------------------: | -----------------------: | ---------------: | ---------------: |
| Render wall time                                        |                       589 ms |                   516 ms |           876 ms |           766 ms |
| SQL (801 calls, 267 queries)                            |               12.3 ms (2.1%) |           12.0 ms (2.3%) |   15.1 ms (1.7%) |   12.1 ms (1.6%) |
| ROM inflate (1,633 files, 8.8 MB)                       |               42.8 ms (7.3%) |           42.7 ms (8.3%) |   68.5 ms (7.8%) |   65.5 ms (8.6%) |
| Lazy Wasm compilation (cold minus warm)                 |                73 ms (12.4%) |                        0 |   110 ms (12.6%) |                0 |
| PHP execution (the rest)                                | 534 ms (90.7% incl. compile) |           462 ms (89.5%) |           797 ms |           687 ms |
| CPU on other threads (V8 background compile)            |                       337 ms |                    83 ms |           383 ms |            78 ms |
| Not in the render: SQLite seed / PHP boot / kernel boot |             31 / 25 / 214 ms |         31 / 15 / 176 ms | 49 / 34 / 262 ms | 45 / 16 / 207 ms |

The Mac set carries load 2.4 to 3.7 and ran while the rig ran, so it is labeled and not used for any
claim. The Folio arm (`folio` in the summaries) matches native here too (589 ms cold, 518 ms warm on
the rig). Wave 1's 790 ms was a fresh-process render on the Mac; the warm figure for a long-lived
instance is 516 ms on the rig and 766 ms on the Mac. Of the render's wall time, SQL (2%) and ROM
inflate (8%) are the only parts that are host work, and **at most 8% is separable from the PHP
execution thread**: inflate is deterministic (the same 1,633 files each render) and could in
principle be done ahead of use on another thread, which bounds the gain at 1.09x, before the cost of
the first file needing to be ready. SQL cannot start until PHP issues the query. Lazy compilation
is paid once per module and is already spread over V8's background threads (337 ms of CPU on other
threads in the cold render). **No independent PHP-runtime work was identified in this breakdown**,
and about 90% of the render is the interpreter executing PHP on one thread. What would have to
change to move that fraction: PHP would have to expose independent units of work (a task boundary),
or Zend would need to run with an enabled opcode cache (`opcache.enable=0` in the harness, so each
render re-lexes and re-compiles the included files, and how much of the 462 ms that is has not been
measured), or the guest bytecode would have to be visible to a scheduler. Level C (a faster
unchanged Drupal render) is not shown.

### Work Inside One PHP Request

Wave 2b, 2026-10-20, Paisley Park (cpus 2 to 11, `nice 19`, powersave governor, Node 26.10.0) unless a
row says Mac. Raw samples, summaries and the rig records are in `results/20261020-phpintra/`; the
instruments are `scripts/probe/php-compile.ts`, `php-intra.ts` (with `php-tasks.ts` and
`php-task-bridge.ts`), `indirect-sites.ts` and `php-snapshot.ts`, summarized by
`scripts/analyze/intra.ts`. Nothing here is Folio region extraction: the Folio compiler is not
involved in any row, and the explicit API is a harness mechanism.

**Zend compile share.** drupflare ships with opcache off: `DEFAULT_OPCACHE_MODE` is `'off'` in
`src/runtime/opcache.ts`, `OPCACHE_MODE` is an optional variable that no `wrangler*.jsonc` sets, and the
`pack` arm mounts nothing because `OPCACHE_PACK` in `src/ops/opcache-pack.ts` is `undefined` (no cache was
baked). Each row below is a fresh Drupal context rendering once, 20 rounds with the arm order rotated, and
all 60 output digests equal the earlier one (`ed8d6feb`).

| Arm (uncached Drupal render, n=20)                          | Wall median (min to max) | p95 ms | ROM files inflated | Paired wall over `off` |
| ----------------------------------------------------------- | -----------------------: | -----: | -----------------: | ---------------------: |
| `off`, the shipped default                                  |    507.9 ms (505 to 514) |  510.8 |              1,633 |                  1.000 |
| `file`, cold (compile, then write the cache)                |    850.0 ms (846 to 860) |  852.5 |              1,633 |                  1.674 |
| `pack`, a cache baked by a `file` run and mounted read-only |    356.5 ms (332 to 360) |  359.5 |                 72 |                  0.700 |

The pack arm removes 30.3% of the render (151 ms at the median), of which 41 ms is ROM inflate that
opcache never needs because it does not read the source (1,633 files down to 72). **Net of the inflate,
the pack removes 112 ms, 22.1% of the `off` render.** A PHP-side timer per include brackets that number
from above: `opcache_compile_file` over the 1,608 files (8.88 MB) that one render includes takes 166 ms
with the optimizer off (n=5 contexts, 165 to 167) and 326 ms with the shipped optimizer level, which is
33% and 64% of the `off` render, but that call also persists the script, so both are upper bounds. The
compile cost is therefore between about 112 ms (22%) and 166 ms (33%) of the render. It is spread thin:
the median include compiles in 0.05 ms, 8 of 1,608 take over 1 ms, the ten slowest are 8.7% of the total
and the hundred slowest 32.7%. Writing a cache on a cold instance costs 342 ms more than not caching,
so the shipped `file` arm can only pay on a later render in the same instance. The `shm` arm ran
once (n=1, 720 ms) and fits the interpreter memory; its repeat-render gain in a long-lived instance is
not measured. The baked cache is 1,682 files and 25.65 MB.

What this means for splitting: of the 462 ms the wave 2a breakdown called PHP execution, 112 to 166 ms is
compile and the remaining 296 to 350 ms is execution that a cache cannot touch. A baked cache is a
drupflare lever for level C (a faster render, 0.700x here), not a parallel mechanism and not Folio.

**Explicit parallel API, not automatic extraction (B-a).** The harness gives PHP two calls,
`task_submit($fn, $args)` and `task_join($id)`, backed by host functions the PHP shim reaches the way the
zlib bridge does (`vrzno_env('cfwTaskSubmit')`). A submit serializes the arguments, posts them to a private
PHP context in another thread and returns an id; a join blocks the owner in `Atomics.wait` and returns the
unserialized value. Values are copied and nothing is shared, the owner context runs the request in program
order, and the task contexts are plain `php-contexts.ts` contexts (shared compiled module, private heap).
Each request builds 8 independent jobs. The arms alternate per round on one pool of 9 contexts: `plain`
(the request calls its functions directly, untouched native PHP, the primary comparison), `api-inline` (the
same request through the API with no second context) and `api-W` for W = 1, 2, 4, 8 task contexts. Every
output equals the plain output in all 840 samples. n=20 per arm per workload.

| Workload (plain median)                      | api-1 | api-2 | api-4 |  api-8 (min) | api-8 wall, p95 | process CPU, api-8 over plain |
| -------------------------------------------- | ----: | ----: | ----: | -----------: | --------------: | ----------------------------: |
| 8 sha256 chains (317 ms)                     | 1.00x | 1.99x | 3.95x | 7.58x (5.09) |   43.7 ms, 61.5 |                          1.02 |
| 8 short sha256 chains (7.7 ms)               | 0.96x | 1.84x | 3.13x | 4.47x (2.75) |     1.9 ms, 2.6 |                          1.32 |
| 8 preg over 790 KB documents (500 ms)        | 0.93x | 1.40x | 1.85x | 2.14x (2.10) | 233.7 ms, 237.6 |                          1.13 |
| 8 serialize and json round trips (422 ms)    | 0.99x | 1.97x | 3.84x | 6.77x (5.92) |   62.3 ms, 67.6 |                          1.13 |
| 8 gzcompress round trips (496 ms)            | 1.01x | 2.01x | 3.86x | 7.63x (5.12) |   65.0 ms, 95.2 |                          1.01 |
| 8 mixed operations (323 ms)                  | 0.99x | 1.45x | 2.25x | 3.99x (3.60) |   81.0 ms, 85.8 |                          1.03 |
| 8 Drupal render arrays through Twig (447 ms) | 0.98x | 1.87x | 3.55x | 4.51x (3.76) |  99.2 ms, 117.9 |                          1.06 |

Overlap is shown by the workers and not inferred from the speedup. In every api-W sample with W of 2 or
more, the in-worker task intervals overlapped (20 of 20 samples in every cell, `maxConcurrentTasks` median
W in every cell), each task ran on its own worker thread, and the summed task thread CPU matches the
plain request's CPU (320 ms against 316 ms for the sha256 chains at api-8). Where the arguments are small,
the owner thread uses 0 to 1 ms of CPU while it waits. The spread is real: the api-8 minimum is 5.09x for the sha256 chains
(median 7.58x) and its p95 wall is 40% above the median, the same 8-wide stalls wave 2a saw with two spare
cores. The cells that scale least show the serial part of the request: in the preg workload the request
itself builds the eight documents in 187 ms of owner CPU (37% of the request), which bounds the speedup
at 2.7x, and it reached 2.14x. Copy and join costs are small next to the work: serializing and encoding
6.3 MB of arguments takes 2.8 ms and posting them 1.6 ms, the other workloads copy 256 bytes to 1.2 MB
(the Drupal render arrays, 2.3 ms to encode), and decoding results takes 0.1 ms or less. A plain context opens in 69 ms (nine in 119 ms wall, 64 MiB
Wasm memory each); a Drupal context opens in 480 ms (nine in 1.33 s). API overhead at one worker is within
7% of plain for every workload (api-1 and api-inline columns in the summaries). Short tasks still win:
tasks of about 1 ms each reach 4.47x at eight workers, with 32% more aggregate CPU.

**Library path.** The transport now lives in `src/tasks.ts` (`TaskPool`, `serveTasks`,
`createTaskLinks`), exported as `@gmitch215/folio/tasks`, and `php-task-bridge.ts` only adds the PHP shim
shapes and the per-task log. Two rig runs of the same instrument (`20261020-phptasks-lib` and `-lib-b`,
n=20 each, cpus 2 to 11) reproduce the harness at one, two and four workers (the sha256 chains reach 1.99x
and 3.89x against 1.99x and 3.95x). At eight workers the medians across the two library runs are 5.34x and
6.77x for the sha256 chains, 5.56x and 6.62x for serialize and 6.52x and 7.71x for gzcompress, against
7.58x, 6.77x and 7.63x in the earlier harness run. The Drupal render arrays reach 6.04x (one library run)
against 4.51x. The eight-wide median moves by up to 1.4x between runs of the same code, so the library path
matches the harness within that spread and the cause of the spread is not isolated. Outputs equal the plain
output in every sample. The pool passes values by copy and trusts the program to name independent tasks.
The optional audit runs every nth task again in the joining thread and fails on the first differing byte;
it detects a task that depended on state a serial run would have shared, at the cost of one serial
execution per checked task, and it is not a read and write set validator.

**Past eight workers.** The same pool at 4, 8, 10, 12 and 16 workers on a 48 job request (so every width
splits the work nearly evenly), n=20 per cell on the rig, with outputs equal to the plain run in all 840
samples. Two affinity masks: cpus 2 to 11, which is 10 physical cores, and cpus 2 to 11 plus their SMT
siblings 14 to 23 (`20261020-phpwidth-nosmt` and `-smt`). Paired medians over the plain request:

| Workload (plain median)   | Mask  |    w4 |    w8 |   w10 |   w12 |    w16 |
| ------------------------- | ----- | ----: | ----: | ----: | ----: | -----: |
| 48 sha256 chains (1.92 s) | cores | 3.96x | 7.54x | 6.56x | 7.59x |  8.49x |
|                           | SMT   | 3.95x | 7.53x | 6.63x | 7.70x |  8.65x |
| 48 serialize (2.58 s)     | cores | 3.90x | 7.20x | 6.41x | 7.29x |  8.14x |
|                           | SMT   | 3.95x | 7.32x | 6.78x | 7.93x |  9.04x |
| 48 gzcompress (2.96 s)    | cores | 3.95x | 7.64x | 6.68x | 7.60x |  8.43x |
|                           | SMT   | 3.95x | 7.69x | 8.82x | 8.61x | 10.53x |
| ideal for 48 jobs         |       |  4.0x |  8.0x |  9.6x | 12.0x |  16.0x |

Scaling is within 10% of ideal through eight workers on ten cores, then flattens: twelve and sixteen workers
on ten physical cores add 10% to 13% over eight (8.1x to 8.5x at sixteen). The SMT siblings add little to the
sha256 chains (8.65x against 8.49x at sixteen) and more elsewhere (10.53x against 8.43x for gzcompress),
while summed thread CPU rises to 1.36x to 1.54x of serial at sixteen because two threads share each core.
The ten-worker cell is bimodal: in the sha256 and gzcompress runs without SMT 13 or 14 of 20 rounds sit at
6.2x to 6.8x and the other rounds at 7.2x to 9.2x, close to the ideal 9.6x, which looks like a lane sharing a
core in most rounds when ten workers and the main and V8 helper threads compete for ten cores. That
explanation is a hypothesis; placement was not recorded. The plateau therefore tracks the physical cores in
the mask and the workload's use of them, not a fixed limit at eight isolates. This is the Ryzen 9 9900X
under the `powersave` governor with other tenants possible; cpus 0 and 1 and their siblings were left out of
every mask.

**Automatic extraction (B-b): the two feasibility experiments.** Neither supports building it.

Indirect-call specialization. `indirect-sites.ts` rewrites every `call_indirect` in `php8.5.tuned.wasm`
(6,679 sites, 0 unreadable functions) so its target operand goes through a counting import, and runs the
instrumented module (digest of all three renders equals `ed8d6feb`). Counts are deterministic, so this set
ran on the Mac and is labeled as such. In the uncached Drupal render (3 renders, 13.13 million indirect
calls, 399 sites executed, 1,030 distinct targets), 20.9% of calls are at sites with one target and 27.4%
at sites with 16 or fewer, and a single site (in function 2229) makes 70.6% of all calls with 461 targets,
the most common holding 6.2%. By the purity census class of the target: 72.6% reach functions that touch
a global other than the stack pointer or an excluded node, 18.4% reach functions that themselves call
indirectly, 9.1% reach functions that would be pure if each region had a private stack slice, and 0.0%
reach a function the census calls pure. The 8-job sha256 request is the friendliest case (561,389 calls,
35 sites, 72 targets): 53.6% at monomorphic sites, 32.1% to stack-pointer-only targets, 50.1% to functions
that touch other globals. A guard on the target set is therefore cheap for about a fifth of the calls and
impossible for the dispatch site that carries most of them, and a guarded target would still have to be
worker-safe, which none is under the current rule. Closed mechanism: indirect-call specialization with
pure targets on the unchanged artifact (0.0% of dynamic targets pure; the stack-slice variant reaches 9.1%
of calls on the render). Not measured: exclusive wall time per target.

Private contexts with bounded copy cost. `php-snapshot.ts` copies one context's whole Wasm memory into a
second context that booted the same way and then runs a function and reads a global that only the first
defined. For a plain context, 20 of 20 clones ran the function and returned the owner's global; copying
64 MiB took 40.1 ms median (38.6 to 54.5, p95 42.3) plus 3.1 ms to adopt it, and the first run in the clone
took 0.2 ms. A fork costs as much as one whole task in the B-a workloads (a 1 to 62 ms job). For Drupal, 0
of 5 clones rendered: the first grew the clone's memory and detached its heap view (`TypeError` from
`copyWithin`), the other four returned an empty render (`Unexpected end of JSON input`), at 53.7 ms for 86.6
MB. The cause of the second failure was not isolated; the Drupal context keeps its ROM mount, SQLite
database and filesystem in JavaScript outside the Wasm memory (read from `php-context-drupal.ts`, not
tested), which a memory copy cannot carry. Closed mechanism: forking a Drupal context by copying Wasm
memory.

Decision. An automatic mechanism would first have to find independent PHP operations, and the explicit
API result shows the execution side is not the obstacle: eight private contexts overlapped real PHP
runtime work at 7.58x. What remains untested is the recognizer: a PHP-source or bytecode-level pass that
identifies independent pure calls (such as a `foreach` of `hash()` over independent items) and routes them
through the same task contexts. It is not built, and the objective stays open.

**Claims.** PHP compatibility: shown (wave 1; digests equal in every sample above). PHP concurrency (A):
shown (wave 2a). Intra-request parallel PHP with an explicit API (B-a): shown, with the limits above; the
mechanism is not Folio extraction and changes the PHP source. Intra-request automatic extraction (B-b): not
shown; two mechanisms closed with numbers above. Drupal speedup (C): not shown for Folio or for any
parallel mechanism; a baked opcode cache measured 0.700x of the render for drupflare, which is a different
lever and needs a cache the repository does not yet bake.

### Work and Span of a PHP Request

Wave 4 (2026-10-20, Apple M2 Pro laptop, Node 26.8.2, not the rig) built a work-span profiler for
`php8.5.tuned.wasm`. It answers a measurement question: given one recorded request and a stated set of
removed dependence classes, how long is the longest chain of dependences that remains? Work and span
are in Wasm IR nodes executed, so the trace does not depend on the machine. Time is not measured.

**Method.** `scripts/probe/worksp-instrument.ts` rewrites the module with binaryen. It bumps f64
counters once per straight-line chunk and calls a hook for every load and store. A PHP userland call
is a change of `execute_data` at the one `call_indirect` in `execute_ex`; an entry hook on `execute_ex`
separates consecutive callbacks that reuse a frame address. A segment is the work of one frame between
its child calls. `scripts/analyze/worksp.ts` keeps one 8-byte-granule shadow, builds the dependence
edges (read, write and write-after-read by class) and evaluates `finish[i] = weight[i] + max finish over
kept predecessors`. The ladder is M0 spawn and join only, M1 all conflicts, then M2 stack pointer
renamed, M3 allocator renamed, M4 refcounts as deltas, M5 output ordered, M6 host calls buffered, M7 ordered
speculation. Binding class is the class on the top span path whose edges carry the most weight; ties
report every class. M7 drops write-after-read and write-after-write edges and turns a read-after-write
edge into a replay when the writer finishes after the reader starts. Output schema `folio.worksp.v2`.

**Verification.** A script with 100 function, 50 method, 25 static and 10 callback calls gives 186
invocations (main plus 185) in count mode and trace mode. A hand count of a loop gives `21n + 7` nodes
and the instrumented module matches it. A first version lost nested loads and calls (loads undercounted
by 23 percent on one input); tallies now equal the hook counts exactly and a test covers it. Synthetic
cases A to H in `tests/unit/worksp.test.ts` fix expected values from the definitions and check each
against an independent longest-path calculation; case H recovers eight tasks dispatched through
`call_indirect` in a real Wasm module. The earlier acceptance text had two errors: M0 is not 1.0 for a
shared counter or a chain (spawn-only ignores data, so 8.0), and "overlapping stack slices" cannot be the
`rename_sp` test because every serial trace reuses stack addresses. The check used here is a
read-after-write on stack memory between unrelated invocations; the model is invalid if one exists.

**Count-only sizes (uncached Drupal render, first render in a fresh context, 3 repeats, identical).**
7,714.0 M IR nodes, 1,241 M loads, 566 M stores, 4,613 MB loaded, 2,187 MB stored, 24.4 M direct calls,
10.8 M `call_indirect`, 33,785 host calls, 7.45 M opcode dispatches, 291,151 userland invocations,
maximum depth 94, no `memory.copy` or `memory.fill`. Counter mode runs 4.6x slower than the original
(810 ms to 3.7 s). The full trace runs 150x to 169x slower (about 140 to 155 s) and produced a graph of
2.32 M nodes, 18.5 M edges and 48.1 M merged interval records; the analysis takes about 8 s. Two
repeats give the same ladder.

**Ladders.** Parallelism per rung; rungs after M1 are invalid under the stack check and the number in
brackets is computed with that precondition ignored (`unchecked`, not a valid model). Binding class in
the last column is the unchecked class for M2 to M6.

| Input (n)                  | M0    | M1    | M2 to M6 | M7      | binding M1 / M2 to M6 / M7                       |
| -------------------------- | ----- | ----- | -------- | ------- | ------------------------------------------------ |
| Drupal render (2)          | 20.44 | 1.000 | [1.000]  | [0.882] | stack+static / static / heap                     |
| 8 sha256 chains (1)        | 7.97  | 1.000 | [1.000]  | [1.000] | stack+static+allocator+heap / static+heap / heap |
| serial dependent chain (1) | 264.4 | 1.000 | [1.000]  | [1.000] | stack+static+heap / static+heap / static+heap    |
| serialize and json (1)     | 8.13  | 1.000 | [1.000]  | [0.510] | stack+static+heap / static+heap / heap           |
| Twig render arrays (1)     | 179.5 | 1.000 | [1.000]  | [0.799] | stack+static+heap / static+heap / heap           |

M4 equals M3 because no refcount tag was verified: a static pattern matched 270 store sites, and in
string, array and object experiments none hit the refcount address, so untagged writes stay conflicts.
The M7 values below 1.0 come from replays: a replayed segment pays its run twice. A sensitivity table
that removes one class at a time from M1 stays at 1.0 for each of stack, static, allocator, heap and host
on every input, and removing everything except one class leaves 1.0 for stack, static and heap (and 1.05
to 1.4 for allocator and host on the Drupal render).

**Cross-check with the explicit task result.** For the sha256 chains the explicit task API measured
7.58x at 8 workers (rig, n=20). The ladder predicts 7.97 only at M0, where every data dependence is
ignored, and 1.0 at every rung that keeps the recorded conflicts, with static and heap binding after
M6. The two do not agree and the disagreement is a result. Private contexts remove every class at once,
including shared heap and static words that this model keeps. At segment granularity a call reads
shared interpreter state at its start and writes it at its end (for example `executor_globals`), so
one such word serializes whole calls even when a finer model would see a short critical section.
The ladder therefore bounds what the listed switches can buy, and it understates what full isolation buys.

**What the trace cannot say.** One input per shape, one machine; instruction counts, not time; host
calls cost nothing and imports other than `emscripten_memcpy_js` do not report their writes; allocator
class covers the exported entry points only; the 8-byte granule counts neighbours as conflicting; the
stack bound (32 MiB below global 0) is assumed; the refcount and `rename_alloc` preconditions are
unverified or unchecked; silent stores that restore a value are conflicts. Nothing here says a render has
a ceiling: the number belongs to this program, this input and the removed set. The class sensitivity
table says what to attack next. No class removal alone moves the Drupal render off 1.0, so the first
primitive that can matter is one that privatizes several classes together (per-task executor globals,
frame and heap state), which is the private-context mechanism of wave 2b with a recognizer in front of
it. A negative result closes the switches of this ladder on this input, not the objective.

### Free-Account Consumer Harness and PHP Platform Limits

Limits were read from the live Cloudflare pages on 2026-10-20 (`/workers/platform/limits/`,
`/workers/platform/pricing/`, `/durable-objects/platform/limits/`,
`/workers/runtime-apis/webassembly/`, `/browser-run/limits/`, `/browser-run/pricing/`). They confirm the
relayed figures: 64 MiB uncompressed bundle on Free and Paid, 128 MB per isolate including WebAssembly
allocations, 1 s startup, 10 ms CPU per Free HTTP request, 30 s default CPU for a SQLite-backed Durable
Object on both plans, no threads in Workers, and on Free 10 browser minutes a day, three concurrent
browsers and one new browser every 20 s. The pages do not say what Free does past a quota.

The harness is `experiments/consumer/`. A Worker launches Browser Run, serves the page, one lane
script and one original module plus its trusted metadata per consumer, and the page runs the paired
rounds. Each round runs the native instance and every Folio arm on a fresh private memory, rotates
the arm order, and compares the whole memory and the return values to native after every call (a 64-bit
word hash each sample, SHA-256 at round 0). Run `cfw-folio-consumer-a0d5b5a6` on the FREE account, n=30
pairs per case, 70 s of session wall time, Chromium reporting four hardware threads and no JSPI. Not
measured: CPU, because a page exposes no process CPU. The browser path uses its own
`minimumParallelWork` gate and not the wave 1 admission rule in `extract.ts`; the gmux ABI and tinyimg
have no counted-loop plan at all (`host or non-memory imports`, `one imported memory required`), so
they take the serial path and the rows below show that path costs nothing measurable, not that Folio
speeds them up.

| Consumer and case                             | Native median (min, max) ms | Folio arm | Folio median ms  | Paired speedup, median (min, max)  | Dispatch (messages, JSON bytes) |
| --------------------------------------------- | --------------------------- | --------- | ---------------- | ---------------------------------- | ------------------------------- |
| kernel control, 67 words x 524,288 rounds     | 61.75 (60.30, 62.99)        | 2 lanes   | 31.93            | 1.929 (1.77, 2.00)                 | native-shared, 2, 90            |
|                                               |                             | 4 lanes   | 17.36            | 3.595 (2.01, 3.85)                 | native-shared, 4, 180           |
|                                               |                             | 8 lanes   | 19.93            | 3.107 (2.65, 3.85)                 | native-shared, 8, 352           |
| gmux ABI memset, memcpy, chain (16 MiB, n=30) | 0.76, 1.29, 1.38            | serial    | 0.78, 1.35, 1.36 | 0.993, 0.949, 1.011 (0.61 to 1.42) | serial, 0, 0                    |
| tinyimg, 13 operations on a 1024 x 1024 image | 1.36 to 123.59              | serial    | in summary       | 0.972 to 1.012 (0.48 to 3.0)       | serial, 0, 0                    |

The kernel control shows a deployed backend can win: 3.6x at four lanes, with eight lanes on four
threads slower than four. The serial consumers show the Folio route adds no measurable wall time on
Browser Run, with single-round extremes of 0.48x to 3.0x from a four-thread Chromium shared with
other tenants. The summary is `experiments/consumer/results-free-consumer-20261020.json`.

PHP on the same account was measured with `experiments/consumer/php/`: a Worker and a SQLite-backed
Durable Object that boot the original `php8.5.tuned.wasm` through the consumer's own glue. CPU comes
from `wrangler tail` (`cpuTime`), startup from the upload response, and every PHP output equals the
SHA-256 chain Node computes. The summaries are `results-free-php-20261020.json`,
`results-free-prepared-combined-20261020.json` and `results-free-prepared-parts-20261020.json`.

| Question                                                               | Measured on FREE                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does the original PHP module (13,401,751 bytes) deploy?                | Yes. Upload 13,615 KiB, startup 1 to 2 ms of 1,000 ms.                                                                                                                                                                       |
| Does the four-module prepared set (58,012,138 bytes) deploy?           | Yes. Upload 57,183 KiB (55.8 MiB) against 64 MiB, startup 3 ms. Folio's current admit plan for PHP is the original module alone, so this is the forced coordinator set from wave 0.                                          |
| PHP boot and work in a plain Worker handler                            | Returned 200. CPU 84 to 105 ms for boot and 195 to 224 ms for 20,000 hashes, against the documented 10 ms. The limit did not refuse these requests; n=4, one per deploy.                                                     |
| PHP in a Durable Object                                                | Cold boot 102 ms CPU (46 ms on a second boot), 20,000 hashes 54 to 56 ms warm (139 ms first), 200,000 hashes 511 and 523 ms. Outputs exact in every call.                                                                    |
| Isolate memory with PHP booted                                         | A streamed ballast of JS buffers reached 184 MiB before the isolate was reset (`exceededMemory`), and PHP linear memory reached 230.4 MiB. The documented 128 MB was not the observed boundary. n=1 per kind.                |
| Same, with the prepared set in the bundle                              | The ballast reached 88 MiB and PHP linear memory 142.4 MiB in both prepared deploys, roughly half to two thirds of the original-only bundle's headroom, which holds 42 MB less Wasm. n=1 per kind per deploy.                |
| Prepared modules in a clean Durable Object isolate                     | The 4.8 MB shared-memory worker module, the 8.5 MB tracked module and the 31.2 MB coordinator (57,145 imports) each instantiate with stub imports, at 129, 135 and 319 ms CPU. Nothing was run: no JSPI, host calls or plan. |
| The three prepared modules instantiated in one isolate with PHP booted | The isolate exceeded its memory limit and was reset (199 ms CPU, n=1). Which module crossed the limit was not isolated.                                                                                                      |

The relayed risk that 55.3 MiB of prepared modules cannot deploy, and the risk that startup would
pass 1 s, are both refuted by deployment. What the platform refuses is co-residence: the booted
interpreter and the prepared set do not fit one isolate, and the headroom left by the prepared bundle
is smaller than the original's. This is a platform measurement and not a PHP speedup: Folio's PHP
route is the untouched original module, which already runs on FREE (the drupflare report records a
195 MiB plateau and 3 to 6 ms startup on the same plan). A deployed parallel PHP result waits for an
admitted region.

### Distributed Page Ownership and Writeback

`src/pages.ts` (`@gmitch215/folio/pages`) implements a bounded volatile directory, resident leases,
immutable page-owner transport and a reference in-memory owner. Canonical state consists of
page/version/owner references and explicit zero-page declarations, without a contiguous canonical
heap. The wasm32 domain holds up to 65,536 pages of 64 KiB. Logical growth allocates metadata only.

Acquisition locks all requested pages or none. Readers share locks; writers exclude other leases.
Scopes contain tenant, session and directory incarnation; increasing fences identify immutable
versions. Commit snapshots write views before its first await, stages every owner, rechecks expiry
after each await and publishes the full manifest in one synchronous decision. Failure or lost
response leaves the previous manifest intact. Idempotent discard fences delayed stage requests
after cleanup. Expiry does not release a busy operation's locks. Transports must impose deadlines;
a never-settling request keeps its locks and credits.

Owner storage, leases, resident pages, commit snapshots, page lists and retired-version metadata
have finite credits. Cleanup failures keep credits charged and eventually refuse further commits.
Missing materialized versions raise errors; only declared zero pages become zeros. A stale or
modified local view cannot mutate published owner versions. Escaped caller views cannot be
physically revoked and lie outside admission accounting. Credits are not RSS measurements.

Ten failure tests cover publication, conflicts, expiry across awaits, late staging, response loss,
owner failure, cleanup bounds, growth, missing pages and stale scopes. The actual native Wasm probe
(`scripts/probe/pages-probe.ts`, `results/page-leases-20261020.json`) compares an 8 MiB logical arena
with an untouched native oracle: 6 MiB materialized over four owners with 2 MiB credit each,
512 KiB charged residence including commit snapshots, 256 KiB native region memory and 24 span
executions. Every byte and the scalar result agree. Final leases, resident bytes and garbage are
zero. This is local protocol evidence with copied pages and explicit spans, not deployed aggregate
capacity or transparent native Wasm paging.

The directory/ownership approach follows shared virtual memory [18]; fences follow generation
sequencers [19]. One trusted directory may be active per scope. Restart requires a fresh
incarnation, persisted manifest and transaction decision log, and durable or replicated owners.
The reference implementation has neither crash recovery nor durable owners. Durable Objects can
share globals and lose in-memory state on eviction [20]; names and retention cannot replace this
recovery protocol.

Arbitrary native Wasm needs a compiler address-rewriting boundary or an existing guest page ABI.
Resolve and lease bounded spans before native execution, then write back before release/remap;
no RPC occurs per native load. For unknown dynamic footprints, suspend at an instrumented fault
or use a resumable interpreter with explicit logical-to-resident translation. That is the capacity
path; allocating the whole native heap at the coordinator would restore the original quota.
General browser CFG extraction without JSPI likewise needs a continuation/state-machine pass for
locals, labels, calls, traps and ordered effects. Counted-loop dispatch does not provide that pass.

**PHP and Thunder.** An earlier census found 1,183,236 scalar memory sites in the 13,401,751-byte
PHP 8.5 artifact (active data ended at 4,206,482), plus 260 HEAP references and 21 invoke or
JS-longjmp trampolines in the 400,452-byte glue. These are artifact-specific measurements, not a
new census. A paged or shared integration must preserve initialization, stack and TLS, typed
accesses, growth, libc bulk operations and every glue HEAP access. A wasm-SjLj build removes the
JS longjmp trampolines, but synchronous vrzno Proxy callbacks still need an explicit value-based
boundary before suspension [15][4]. An earlier re-entry interpreter loaded the real PHP module and
returned PHP 8.5.2, extension API 20250925 and stack pointer 37916928, with 40,370,176 bytes of
interpreter memory plus 64 MiB of contiguous guest memory. That proves binary compatibility and
does not prove PHP boot or a Drupal render. For Thunder, an admitted backend is chosen before
execution, URL, session, headers and cache metadata are kept, and a destructive out-of-memory is
never recovered by replaying writes blindly. The local proof above covers an actual uncached
render, SQLite, ROM and one caught exception. Deployed Thunder execution and broader callback and
longjmp coverage remain separate consumer checks.

**gmux.** Linux mappings, protection, fds and scheduling stay in gmux. Folio supplies execution,
arena and validation primitives. Independent process execution is the natural first consumer;
shared writable mappings and futex or atomic coherence need explicit semantics. Neither consumer
takes a dependency on the other.

---

## 📜 Historical Copied-Memory Results

These predate physical sharing and serve as evidence for a managed capacity workaround. They are
not shared backing.

| Experiment                                                     | Result                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 256 MiB virtual space, 16 MiB executor cache, 4x 64 MiB owners | 67,108,864 words exact; dirty eviction and boundary tests                                          |
| Resident checked paging                                        | 6.532 ms native, 32.627 ms checked, 4.995x paired tax, n=7                                         |
| Local workerd per-page fetch                                   | 24,584 exchanges, 3,268 ms, exact                                                                  |
| Local duplex streams                                           | four executor fetches, same 24,584 exchanges, 7,339 ms, exact; fewer requests, slower on localhost |
| Mutable stencil, 4 MiB, 8 epochs, 16 mixes                     | 172.73 ms serial, 50.99 ms four owners; 3.396x, CPU ratio 1.003                                    |
| Stencil, 32 MiB stream                                         | 78.83 ms serial, 31.71 ms four owners; 2.537x paired                                               |
| Stencil, tiny 16 KiB                                           | 0.198 ms serial, 0.556 ms four owners; parallelism loses                                           |
| Flat 48-pass 16 MiB sum                                        | 38.632 ms ordinary, 357.478 ms per-load checked                                                    |
| Translate once per page                                        | 39.179 ms; 1.014x of the matched ordinary loop                                                     |
| Validate a contiguous span once                                | 38.660 ms; 1.0002x                                                                                 |
| Irregular bounded indexing                                     | 4.872 ms ordinary, 8.271 ms checked, 4.888 ms whole-span guarded                                   |

The stencil work uses explicit partitions and epoch barriers. The paging prototypes have no durable
fencing or recovery and no coherent arbitrary concurrent writers. Fast spans need complete range,
residency and permission proofs, no escaping physical views, and no remapping or yield inside the
lease. Burrow's earlier deployed eight 96 MiB isolates show aggregate capacity; resets near 190 to
200 MiB are empirical and not an entitlement, so admission follows the provider's published memory
contract [16]. A copied ownership backend needs bounded frames and credits, tenant and epoch checks
at every owner, acknowledged dirty writeback before eviction, explicit missing-page errors,
zero-page manifests, growth semantics and checkpoints for owner loss, with no SQL write per load,
store or fault.

---

## ⚠️ Limits and Open Questions

These came out of two external audits of the first managed-bridge draft. Each row names its status:
open work, a reporting rule, or a claim this report does not make.

| Question                                                                                                                                                                                                         | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PHP preparation exceeded V8's function cap because Folio emitted a helper per memory site.                                                                                                                       | Resolved: 12,378 original defined functions; corrected coordinator 191,925 defined, 66,023 helpers, all binaries validate. Boot/render is a separate check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `module UUID` counts distinct module instances. It is not a native V8 isolate identifier, and named objects can share an isolate. Managed rows report the identities they measured and no more.                  | Reported as measured; no native isolate identity exists for managed runs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| A FREE-account run was previously missing.                                                                                                                                                                       | Resolved for browser automatic extraction: run `cfw-folio-browser-72ad9035`, 256 MiB, no JSPI, all bytes/returns exact, baseline restored. Earlier DO kernel figures remain STUDENT measurements.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Managed medians use two samples per arm and include preparation, admission, a serial oracle and close. No isolated kernel timing, warm and cold split, or snapshot scaling curve toward the 32 MiB limit exists. | Open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Managed Workers have no aggregate CPU measurement and Folio has no energy measurement on any route.                                                                                                              | Not claimed; energy is open                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 7x on managed Workers needs a small serial fraction. Nothing here shows it, and nothing here proves a 1.6x ceiling either.                                                                                       | Not claimed in either direction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Node's 7.519x remains a synthetic kernel result.                                                                                                                                                                 | gmux coverage now recorded: core 6/12, lifted region 0/1, process artifact 63/188; three real process-memory calls exact. Full process/Thunder speedup remains unmeasured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The managed snapshot backend still needs its canonical heap to fit its owner.                                                                                                                                    | Page leases/writeback now implemented and locally tested with native spans. Transparent arbitrary-Wasm paging, remote owner adapters and durable recovery are still required for a managed capacity fallback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Browser Run has no JSPI in the measured managed configuration.                                                                                                                                                   | Counted-loop automatic extraction implemented and deployed; general CFG continuation lowering remains open. Separate product and allowance limits still apply.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| No PHP speedup exists on any backend.                                                                                                                                                                            | Open. Ten userland workloads (n=20) and the Drupal render (n=10) dispatch zero workers on Node, on an M2 Pro and not the rig. Closed: existing regions on builtins and host `runAll` over exported hash updates, and (wave 2b) indirect-call specialization to pure targets and forking a Drupal context by Wasm memory copy. Open: private stack slices (ceiling 1.12x on the profiled render), speculative controller loads, shared heap, an automatic recognizer for the explicit task API.                                                                                                                                                                                                                                                                                                                                                                         |
| Independent PHP requests: do they scale, and does Folio add to that?                                                                                                                                             | Shown for the request level (A), not for work inside one request. Paisley Park, n=20 (CPU endpoints) and n=10 (Drupal render): 7.06x median at eight instances for the Drupal render (min 6.69), 5.1x to 7.7x for the CPU endpoints, tail latency 14% above single-request at eight. Folio arms run the original module (the admit plan has no region) and match native at 1.00 median. Not shown: any gain from Folio, any parallel work inside one request, energy. Instruments `php-contexts.ts`, `php-concurrent.ts`; results `20261020-phpparallel/`.                                                                                                                                                                                                                                                                                                             |
| How much of the uncached Drupal render is independent of the PHP thread?                                                                                                                                         | At most 8% (ROM inflate), plus 2% SQL that PHP triggers, plus 12% lazy compile in a cold process that V8 already spreads over background threads. About 90% is PHP execution on one thread with no independent unit identified. Resolved in wave 2b: Zend compilation is 22% to 33% of the `off` render (112 to 166 ms of 508 ms, n=20 and n=5 contexts), so execution that no cache removes is about 296 to 350 ms. See "Work Inside One PHP Request".                                                                                                                                                                                                                                                                                                                                                                                                                |
| Does an explicit task boundary overlap real PHP work inside one request, and does automatic extraction?                                                                                                          | Explicit API shown (B-a), not Folio: 8 independent operations on private contexts run 7.58x (sha256 chains), 7.63x (compression), 6.77x (serialize), 4.51x (Drupal render arrays through Twig), 3.99x (mixed), 2.14x (preg with a 37% serial setup) at 8 workers against untouched native PHP, n=20 per arm on Paisley Park, outputs equal in all 840 samples, process CPU ratio 1.01 to 1.13 (1.32 for 1 ms tasks). Automatic extraction not shown: 0.0% of dynamic `call_indirect` targets in a Drupal render are pure, 70.6% of calls go through one site with 461 targets, and cloning a Wasm memory costs 40 ms per fork and fails for Drupal (0 of 5). Open: a PHP-source or bytecode recognizer feeding the task contexts, and what share of real Drupal work such a pass could mark independent.                                                               |
| How parallel is an uncached Drupal render under a stated set of removed dependence classes?                                                                                                                      | Measured once per shape on a laptop in IR nodes executed: 291,151 userland invocations, 7.7 G nodes. Spawn and join only gives 20.4, every recorded conflict gives 1.000, and the rungs after M1 are invalid because 817,245 stack read-after-write edges join unrelated invocations; with that check ignored they stay at 1.000 (static binds, then heap) and speculation falls to 0.882 from replays. M4 equals M3 because 0 refcount tags were verified. The sha256 chains give 7.97, 1.000 and 1.000 against the measured 7.58x of private contexts: no agreement, and the model keeps shared static and heap words that private contexts copy. One input per shape, no time, host calls free, 8-byte granules. Open: a dataflow-aware refcount matcher, an allocator epoch model, silent-store removal, finer than whole-call segments.                           |
| Is the work-span trace affordable?                                                                                                                                                                               | Counter mode costs 4.6x and the full trace 150x to 169x (about 150 s) on the Drupal render, with 48.1 M merged intervals, 2.3 M nodes and 18.5 M edges at 8-byte granules; interval merging per segment kept the trace inside memory without sampling or caps. Not measured on the rig or for other inputs at full size.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Can a faster Drupal render come from the compile share?                                                                                                                                                          | Not Folio, not parallel. A baked read-only opcache (`pack` arm) renders at 0.700x of the shipped `off` arm (508 to 357 ms, n=20, 1,682 files and 25.65 MB of cache); `file` cold is 1.674x and `shm` was run once. The repository bakes no cache (`OPCACHE_PACK` is undefined). Open: a repeat-render figure in one long-lived instance for `file` and `shm`, and the cache size against the deployed limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| The consumer harness found no consumer speedup, and Folio no longer slows the consumers it cannot split.                                                                                                         | Before static admission tinyimg, the gmux process artifact, the gmux core and a serial recurrence ran 0.0002x to 1.0x of native with up to 14,892x the CPU. Now none has an admitted region and each runs the original module at 0.96x to 1.03x with a CPU ratio near 1 (tinyimg, gmux ABI, serial recurrence and PHP, n=20 to 60, M2 Pro, not the rig). The kernel control keeps 7.48x at eight workers against 7.41x for the old build (n=40). Missed: the gmux core ready queue at 0.052x per call, where each call is about 34 ns and `Folio.run` adds about 0.65 us. The 200,000 threshold is calibrated on one machine and gives up speedup for independent regions of 15k to 200k units. Open: the same calibration and paired rerun on the Paisley Park rig.                                                                                                   |
| A FREE-account run of the harness or of PHP was not made.                                                                                                                                                        | Resolved for the platform. Browser Run on the FREE account runs the paired harness (n=30): kernel control 3.6x at four lanes, gmux ABI and tinyimg 0.97x to 1.01x through the serial path, outputs exact, CPU not measurable in a page. The original PHP module and the 55.8 MiB prepared set both deploy (startup 1 to 3 ms) and the original boots and runs PHP workloads with exact output in a Durable Object. Refused: a booted interpreter plus the prepared set in one isolate (`exceededMemory`), and the documented 128 MB is not the observed isolate boundary (184 MiB of buffers, 230.4 MiB of PHP memory, n=1). Open: any deployed PHP speedup (Folio's PHP route adds nothing), an executed prepared coordinator on the target, and the same harness on the managed Durable Object backend. See "Free-Account Consumer Harness and PHP Platform Limits". |
| The 101 library and probe tests in the earlier record came from a log that was read and not re-run by the auditors. The current gate is listed under Reproduction and Verification.                              | Superseded                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

Free and Paid show no measured difference in memory semantics, and nothing here argues that
upgrading changes the cross-isolate barrier.

---

## ✅ Reproduction and Verification

From the repository root, with Node 26 on `PATH`, Bun, and an LLVM toolchain with `wasm-ld`:

```sh
bun install
bun run build:c
bun run typecheck
bun run test
bun run test:integration
bun run build
node examples/basic.ts
bun scripts/analyze/run.ts
```

`bun run build:c` compiles the three C fixtures in `tests/c/` with the existing freestanding
LLVM and clang flags, without Emscripten. Builds strip `node_modules/.bin` from `PATH` because
binaryen's `wasm-opt` there changed a 511-byte fixture into a 458-byte one; a regression test
covers it. Measurements run on Paisley Park through `scripts/rig/run.sh`, which holds the timing
lock and applies `nice 19` with a fixed CPU mask. Local probes and the live deploy:

```sh
node experiments/cloud/host-probe.ts
node experiments/cloud/local.ts
node experiments/managed/prepare.ts
node experiments/managed/local.ts
node experiments/deploy.ts managed
node experiments/cleanup.ts NAME KIND
```

Live deploys read `FREE_CLOUDFLARE_ACCOUNT_ID` and `FREE_CLOUDFLARE_API_TOKEN` (falling back to
`STUDENT_*`), snapshot the account's scripts, namespaces, KV, R2 and D1 first, and compare them afterwards.
FREE consumer harness: `node experiments/consumer/prepare.ts` and `node experiments/consumer/php/prepare.ts`
stage the assets, `node experiments/consumer/local.ts CONSUMER PAIRS OUT.json` runs the page in a local
Chromium, `node experiments/deploy.ts consumer|php|prepared` deploys, measures and tears down, and
`experiments/consumer/analyze.ts` and `experiments/consumer/php/analyze.ts RUN OUT.json` write the summaries.
Real-artifact comparison: `node scripts/probe/integration-probe.ts TINYIMG.wasm GMUX-CORE.wasm`.
Consumer harness: `node scripts/probe/consumer.ts scripts/probe/consumers/tinyimg.ts OUT.jsonl 20 1,2,4,8`
(`FOLIO_OLD_BUILD=1` adds the archived pre-admission build), then `bun scripts/analyze/paired.ts SET FILE.jsonl`.
Admission: `node scripts/probe/admission-calibration.ts OUT.jsonl`, `node scripts/probe/admission-sites.ts OUT.jsonl CONSUMER.ts...`
and `bun scripts/analyze/admission.ts SET`. PHP: `FOLIO_CONSUMER=... node scripts/probe/php-workloads.ts OUT.jsonl 20`,
`php-render-pairs.ts` and `purity-census.ts MODULE.wasm OUT.json`. Concurrent PHP: `FOLIO_CONSUMER=... node scripts/probe/php-concurrent.ts cpu|drupal OUT.jsonl`, `php-concurrent.ts memory OUT.jsonl cpu|drupal native|folio COUNT` and `drupal-breakdown.ts OUT.jsonl`, on the rig through `scripts/rig/php-concurrent.sh SET` and `drupal-breakdown.sh SET`, then `bun scripts/analyze/run.ts`. Work inside one request: `FOLIO_CONSUMER=... node scripts/probe/php-compile.ts OUT.jsonl 20 5`, `php-intra.ts OUT.jsonl 20 1,2,4,8 [WORKLOADS]`, `indirect-sites.ts OUT.jsonl 3` and `php-snapshot.ts OUT.jsonl 20`, on the rig through `scripts/rig/php-intra.sh SET` (steps `compile intra intra-drupal snapshot`). The 2026-10-20 wave 2b unit run had 20 files and 170 tests passing (8 new in `tests/unit/php-intra.test.ts`); `src/` was not changed by that wave, so integration was not rerun.

The scaling record is `results/20261019-d/`: 207 raw samples, a deterministic summary, the runner
log and the exact measured `source.tar.gz`. The final placement run keeps 56 measured samples and
16 warmups in `results/20261020-affinity-final/`. `results/verification.json` and
`results/managed-bridge-verification.json` index the earlier gates, with their logs beside them.
The summaries in `results/*/summary.json` regenerate byte for byte from the raw samples with
`scripts/analyze/`, apart from the row order of `results/20261019/summary.json`, which now sorts
its input files.

Current gate on Node 26.8.2: typecheck passes for the library and three Worker projects;
**156 tests pass** (153 unit run on 2026-10-20 after the PHP concurrency harness landed, 3 integration from the earlier run, since `src/` is unchanged), with no failures or skips. Coverage is 88.93% of
statements, 83.6% of branches, 91.23% of functions and 92.03% of lines. The library builds;
`examples/basic.ts` reports four workers and four native-shared regions with zero replays and
fallbacks. The generated documentation builds with nonfatal documentation warnings. The integration project runs the host
probe, the capability probe and all 39 managed rows in local workerd (1.20261019.1).
`worker.ts` and `browser-worker.ts` run outside the coverage provider's instrumented realm.
The dedicated FREE browser extraction deployment passed and restored its baseline; the general
e2e workflow itself was not dispatched during this work. The real PHP/Drupal probe is additional
consumer evidence outside these 151 tests. The compiler, runtime, probes and the pre-fix
extractor are retained in `results/folio-v1-proof-sources-20261020.tar.gz`, which also holds the
first copy of the Drupal harness that `scripts/probe/php-render.ts` now replaces.

Rig footprints on Paisley Park stayed small (control 752 KiB, placement 1020 KiB, the earlier rigs
200 to 264 KiB), with 133 GiB free on `/` and over 25 GiB of available RAM afterwards. No server
setting, package installation, unrelated service restart or protected mount access was involved.

---

## 📚 References

Numbers appear in order of first use. Sources with a pinned commit or tag name it.

[1] Node.js, `node_messaging.cc` sender, v26.10.0: <https://github.com/nodejs/node/blob/v26.10.0/src/node_messaging.cc#L371>

[2] Node.js, `node_messaging.cc` receiver, v26.10.0: <https://github.com/nodejs/node/blob/v26.10.0/src/node_messaging.cc#L196>

[3] V8, backing-store lifetime contract, as vendored in Node.js v26.10.0: <https://github.com/nodejs/node/blob/v26.10.0/deps/v8/include/v8-array-buffer.h#L556>

[4] V8, "WebAssembly JavaScript Promise Integration": <https://v8.dev/blog/jspi>

[5] Hammond et al., "The Stanford Hydra CMP," sections 3 and 4: <https://ppl.stanford.edu/papers/hydra_ASPLOS98.pdf>

[6] Cloudflare, Durable Objects pricing: <https://developers.cloudflare.com/durable-objects/platform/pricing/>

[7] Cloudflare, Workers timing behavior: <https://developers.cloudflare.com/workers/runtime-apis/performance/>

[8] workerd, `jsg/ser.c++`, commit 781048b: <https://github.com/cloudflare/workerd/blob/781048bc05cb205c92e503c1062ef3266ab959b5/src/workerd/jsg/ser.c%2B%2B>

[9] workerd, `api/worker-rpc.c++`, commit 781048b: <https://github.com/cloudflare/workerd/blob/781048bc05cb205c92e503c1062ef3266ab959b5/src/workerd/api/worker-rpc.c%2B%2B>

[10] workerd, `api/messagechannel.c++`: <https://github.com/cloudflare/workerd/blob/main/src/workerd/api/messagechannel.c%2B%2B>

[11] workerd, `node/worker_threads.ts`: <https://github.com/cloudflare/workerd/blob/main/src/node/worker_threads.ts>

[12] LLVM, Polly architecture: <https://polly.llvm.org/docs/Architecture.html>

[13] LLVM, runtime checks of pointers: <https://llvm.org/docs/Vectorizers.html#runtime-checks-of-pointers>

[14] NewAge: <https://arxiv.org/html/1809.07684>

[15] Emscripten, setjmp and longjmp: <https://emscripten.org/docs/porting/setjmp-longjmp.html>

[16] Cloudflare, Workers memory limits: <https://developers.cloudflare.com/workers/platform/limits/#memory>

[17] V8, `wasm-limits.h`, pinned commit 010de10e, function limit (also reproduced by Node 26.8.2): <https://chromium.googlesource.com/v8/v8/+/010de10eb8885dded6f9e71cd2f3d5b376cae6ee/src/wasm/wasm-limits.h>

[18] K. Li and P. Hudak, "Memory Coherence in Shared Virtual Memory Systems": <https://css.csail.mit.edu/6.824/2014/papers/li-dsm.pdf>

[19] M. Burrows, "The Chubby Lock Service for Loosely-Coupled Distributed Systems," OSDI 2006, section 2.4: <https://static.googleusercontent.com/media/research.google.com/zh-CN//archive/chubby-osdi06.pdf>

[20] Cloudflare, Durable Objects in-memory state, including co-tenancy and eviction: <https://developers.cloudflare.com/durable-objects/reference/in-memory-state/>
