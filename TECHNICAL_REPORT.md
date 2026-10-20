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

| backend         | where it runs                          | memory model                                | best measured result                                                        |
| --------------- | -------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------- |
| Node            | co-located `worker_threads` isolates   | one physical allocation, zero copy          | **7.519x** elapsed speedup on eight pinned workers, 4.87% extra CPU work    |
| Managed Workers | named Durable Object lanes, JSPI owner | copied frozen snapshots, ordered validation | **1.618x** end to end (four lanes, binary fetch)                            |
| Browser Run     | Chromium Web Workers                   | one physical 256 MiB Wasm allocation        | **3.874x** with four workers (explicit partitions, no automatic extraction) |

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

| Objective                                            | Status                                                                                                                        |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Physical zero-copy backing across distinct isolates  | Implemented and measured on Node: native handle trace, aliasing, atomics, RSS controls, growth, lifetime                      |
| One entry automatically uses several CPUs            | Final unannotated inlined C: 7.519x median, eight pinned workers, exact full memory                                           |
| Engine-valid Wasm input accepted                     | Original native instance retained; bytes, ArrayBuffer and Module inputs, memories, opaque refs, initialization, async effects |
| Dependence preservation                              | Ordered validation and replay, byte overlaps, trap prefixes, budget fallback; scalar carry stays native                       |
| General automatic region extraction                  | Native CFG coordinator, inline numeric-memory spans, pure call regions, ordered state and effect boundaries                   |
| Managed Workers CPU fan-out                          | Deployed; eight distinct module UUIDs; platform CPU overlap observed                                                          |
| Workerd execution route                              | Portable client plus authenticated host; stock workerd to four Node isolates                                                  |
| Physical shared memory through managed RPC and ports | Refused in deployed tests; the execution host is the workaround                                                               |
| Real consumer compatibility                          | tinyimg and gmux core match native; no full consumer adapter                                                                  |
| PHP boot and render over shared execution            | Not proved (see Consumer Boundaries and Open Questions)                                                                       |

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

The original Wasm engine remains the coordinator. It runs branches, nested loops and calls,
switches, reductions and return values. Helpers evaluate operands in native order, then join
pending regions before canonical memory, global state, growth, host effects or opaque calls.
Opaque calls run with native execution forced, so synchronous reentry cannot spawn untracked work.
Start and data initialization run once in this instance, and workers hold only the outlined or
pure function closure plus the imported shared arena.

JSPI suspends the original stack during joins [4]. Numeric-result controller exports get an
internal promising wrapper; reference-returning exports keep their original ABI. Raw exports and
serial paths select the original bodies through an imported mode global. Float region arguments are
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
countdown adapter without JSPI could bridge it for the guarded subset. Account resources matched
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

## 🧑‍💻 Consumer Boundaries

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
never recovered by replaying writes blindly. A real render with SQLite, ROM, callback and longjmp
coverage and an effects comparison remains required.

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

| Question                                                                                                                                                                                                                                                                                                                                                                  | Status                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| The shipping PHP fails `prepare()` with a 1,258,580-function count against V8's 1,000,000 function cap. The original module's defined and imported function counts, the transformed count and the number of generated helpers have not been compared. The prepared count sits 75,344 above the 1,183,236 memory-site census, which suggests per-access helper generation. | Open. Unresolved until the original and prepared counts are recorded     |
| `module UUID` counts distinct module instances. It is not a native V8 isolate identifier, and named objects can share an isolate. Managed rows report the identities they measured and no more.                                                                                                                                                                           | Reported as measured; no native isolate identity exists for managed runs |
| The recorded deployed runs name the STUDENT account. A run on the account labelled FREE is not on record. `experiments/deploy.ts` now accepts `FREE_*` credentials and records which account ran.                                                                                                                                                                         | Open until a FREE run is recorded                                        |
| Managed medians use two samples per arm and include preparation, admission, a serial oracle and close. No isolated kernel timing, warm and cold split, or snapshot scaling curve toward the 32 MiB limit exists.                                                                                                                                                          | Open                                                                     |
| Managed Workers have no aggregate CPU measurement and Folio has no energy measurement on any route.                                                                                                                                                                                                                                                                       | Not claimed; energy is open                                              |
| 7x on managed Workers needs a small serial fraction. Nothing here shows it, and nothing here proves a 1.6x ceiling either.                                                                                                                                                                                                                                                | Not claimed in either direction                                          |
| Node's 7.519x is a synthetic kernel result. No measured gmux or Thunder speedup exists, and `folio.inspect()` coverage on the gmux machine core and a lifted region is unrecorded.                                                                                                                                                                                        | Open                                                                     |
| Capacity: the managed backend needs canonical memory inside the owner runtime and copies a snapshot per batch, so it is no fallback for Thunder-class memory. Distributed page ownership is unbuilt.                                                                                                                                                                      | Known limit                                                              |
| Browser Run is a separate managed product with no JSPI in the tested configuration, so it has no automatic extraction. Its plan limits and cost were not checked beyond the published Free allowance.                                                                                                                                                                     | Known limit                                                              |
| The 101 library and probe tests in the earlier record came from a log that was read and not re-run by the auditors. The current gate is listed under Reproduction and Verification.                                                                                                                                                                                       | Superseded                                                               |

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
`STUDENT_*`), snapshot the account's scripts and namespaces first, and compare them afterwards.
Real-artifact comparison: `node scripts/probe/integration-probe.ts TINYIMG.wasm GMUX-CORE.wasm`.

The scaling record is `results/20261019-d/`: 207 raw samples, a deterministic summary, the runner
log and the exact measured `source.tar.gz`. The final placement run keeps 56 measured samples and
16 warmups in `results/20261020-affinity-final/`. `results/verification.json` and
`results/managed-bridge-verification.json` index the earlier gates, with their logs beside them.
The summaries in `results/*/summary.json` regenerate byte for byte from the raw samples with
`scripts/analyze/`, apart from the row order of `results/20261019/summary.json`, which now sorts
its input files.

Current gate on Node 26.8.2, run during repository consolidation: typecheck passes for the library
and the three Worker projects; **111 tests pass** (108 unit, 3 integration) with no failures or
skips; the unit and integration projects together cover 88.55% of statements, 83.15% of branches,
91.34% of functions and 91.91% of lines of `src/`; the library builds; `examples/basic.ts` reports
four workers and 37 regions with zero replays and fallbacks. The integration project runs the host
probe, the capability probe and all 39 managed rows in local workerd (1.20261019.1).
`worker.ts` counts as uncovered because it runs in worker threads that the coverage provider does
not instrument. The live deploy test skips without Cloudflare credentials and has not been run from
this repository.

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
