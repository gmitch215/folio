# Method

## Artifact and execution

The consumer supplies PHP 8.5.12 Wasm (14,011,467 bytes), its matching tuned glue,
the seed pack, mount/shim/kernel code, host bridge and `rekey.php`. Their recorded
digests identify the tested input. No interpreter rebuild or source-cache change
was made. `src/bake.ts` supplies capture, encoding, baking and memory application.

Preparation exports the interpreter's four existing mutable globals without
changing their bodies, boots Drupal, renders `/`, and captures the heap delta,
globals, one filesystem stream, four named JavaScript handles and one initialization
EM_ASM record. The handle store is sealed and has no unnameable handle in this
capture. A fresh module establishes the baseline bytes/globals. The embedded arm
bakes the original module; the copied-image arm restores pages and exported globals
before the existing glue replays host state. The captured image has 1,324 pages
(86,769,664 bytes), of which 730 differ from baseline.

## Configuration study

Thirteen hand-selected configurations cover unchanged state, site name, email,
timezone, global favicon setting, theme primary color, enabling the previously
absent `ban` module, maintenance state, cache-tag invalidation, a login path alias,
new promoted content, private key and settings salt. Drupal's own APIs perform each
edit; errors fail preparation. Salt changes at the settings boundary. These are
coverage cases, not a random population of sites or a production eligibility rate.

Four arms use fresh cloned databases and processes:

| Arm         | Admission and renewal                                                                     |
| ----------- | ----------------------------------------------------------------------------------------- |
| `plain`     | Fresh module and Drupal boot                                                              |
| `guarded`   | Exact configuration-table digest; otherwise fresh boot                                    |
| `reset`     | Matching `core.extension` digest, then consumer config/entity reset; otherwise fresh boot |
| `unguarded` | Deliberately ignore admission; renew site state but retain captured configuration         |

The interpreter, glue, pack, host driver, fragments and bridge are fixed inputs in
this matrix. A module-set change is rejected even when this one homepage happens
to look unchanged. Pack/driver/fragment changes are not dynamically exercised here;
consumers must retain their existing compatibility keys. The current consumer's
production context also includes generation, driver and boot settings/fragments.
This harness's module/config comparison is an experimental subkey under those
fixed inputs, not a replacement for the consumer's complete admission policy.

Compare native versus restored first-render HTTP status and normalized HTML SHA256.
Maintenance's expected 503 is valid. Normalize only Views DOM IDs, the existing
permissions hash nonce, and the login input's `form_build_id` value and selector.
Retain SHA256 of each raw form ID. Native-versus-native login controls isolated that
input's randomness before normalization was added. No arbitrary attributes or
content are stripped. State/configuration not visible on a route is not proved by
matching its HTML.

## Replay and security

Run the current consumer renewal PHP verbatim, selecting its config/entity reset
placeholder only for the reset/copy arms. It reinitializes Settings, memory cache,
memory bins, RNG and initialized CacheCollectors. Record every step/error. Compare
the private-key and salt SHA256 to the independently booted native case. Record
three `mt_rand` outputs per restore and raw form-ID hashes to detect repeated
sequences in this cohort. These checks demonstrate observed renewal, not a proof
of arbitrary extension security or RNG distribution.

Record stream/handle replay failures and all four mutable globals. Reconstruct
static function tables from the same module/glue rather than serializing arbitrary
JavaScript callables. Runtime table mutations, unknown host handles, live sockets,
external transactions, credentials retained by arbitrary modules, changed fragments
or changed native imports require an explicit consumer replay contract or a fresh
boot. A successful homepage alone does not authorize these resources. Heap images
can contain secrets; captured binaries and seed databases stay private.

## Lifecycle and generation

Fifteen paired rounds rotate `plain`, `guarded` and `memory` order. Each sample gets
a new process, cloned database and Wasm instance. The measured interval starts
before compilation and ends after first render, including context construction,
mounts, renewal and rendering. Loading image files and the memory-image decode are
inside that interval; reading the selected module bytes is outside. Node elapsed
time and aggregate process CPU are separate instruments. The host is an M2 Pro with
12 logical CPUs; this is one local execution cohort. Builds were paused during
this interval, with a brief typecheck overlapping near its beginning. Existing
system activity and runtime helper threads remain visible in CPU totals.

Bootstrap paired-round medians use the repository analyzer (2,000 resamples, fixed
seed); those intervals are within-run estimates, not independent replication.
Warm second renders expose the application-cache comparison. Renewal is included
in totals but not separately timed. The image-copy arm is an initialized-memory
restore, not a serialized JavaScript or process snapshot.

A separate single preparation measures probe construction, Drupal boot/render,
capture, bake, gzip, files and database backup. It excludes process import and
harness bundling. The break-even model divides that measured generation cost by
the difference of lifecycle medians. It excludes distribution, storage, deployment
and retention costs and is not an observed fleet break-even point.

## Deployed delivery

Each variant uses a separate temporary Free Worker with one SQLite-capable Durable
Object class, but no storage/SQL operations. The handler checks a disposable bearer
token and forwards to the object. The object builds stub imports and instantiates
the precompiled module. The asset arm reads twelve files sequentially and copies
730 pages before restoring the four exported globals. The assets are each at most
4 MiB, below the documented 25 MiB per-file limit.

Each arm attempts twelve distinct objects and twelve calls to one object. Every
request instantiates anew. Four designated requests per arm scan all memory with
FNV-1a; their large scan cost is excluded from ordinary cost summaries. This is a
32-bit consistency check, not a cryptographic equality proof. No PHP boot, Drupal
render or physical-page sharing is claimed by this delivery instrument.

Stored provider events join by request tag. Keep Durable Object CPU/wall separate
from the forwarding Worker. Whole-millisecond meters and client latency are not
interchangeable. A module UUID indicates an execution cohort, not isolate identity.
Different object names do not guarantee separate isolates or fresh physical CPUs.
Retain all HTTP failures, including deployment propagation errors, and report the
successful/metered denominator. No live tail is attached. Initial stored queries
can be empty; query again after logs arrive, without changing runtime behavior.

The initial import-alias build failure and the initial six-second baked readiness
failure are retained. A later diagnostic uses literal Wasm imports and captures up
to fifteen two-second readiness polls; it does not change an application timeout,
memory limit, feature or frame limit. In that retry readiness returned 404 then 200;
one later request also returned a provider 404. Five other earlier responses
correspond to stored `Worker not found.` errors. These are reported as propagation
failures; no successful measurement is imputed to a failed request.

The account is snapshotted before the run. Each class is retired and its Worker
deleted before advancing, and a final snapshot must equal baseline. The completed
study made 72 measurement attempts, plus readiness/API calls, and 240 successful
asset reads. It used zero application SQL rows and stayed below the approved 800
external-request bound. Provider telemetry query scan statistics are not Durable
Object SQL billing rows.
