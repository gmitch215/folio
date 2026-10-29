# Baked Boot Images on a FREE Backend

The question: what does the deployed plane do with a 13.4 MB PHP Wasm module that carries its booted
memory as initial data? Two baked modules come from `scripts/probe/boot-image.ts`: 20.7 MB with the
7.3 MB boot delta and 61.0 MB with the 47.6 MB after-first-render delta. A render from them still
needs the JS-side state replayed, so this probe measures the platform cost of carrying and
instantiating them and nothing about rendering.

## Deploys

Three modules together pass the 64 MiB uncompressed bundle, so each variant is its own deploy
(`FOLIO_BOOTIMAGE_VARIANT=original|boot|render node experiments/deploy.ts bootimage`).
Historical records use `a`, `b` and `c` for these variants respectively; both forms are accepted.

| variant | modules in the bundle                                                | memory per instantiate |
| ------- | -------------------------------------------------------------------- | ---------------------- |
| `a`     | the unmodified module, three own-memory modules, one memory importer | 1024 pages             |
| `b`     | the baked boot module                                                | 1024 pages             |
| `c`     | the baked render module                                              | 1322 pages             |

`prepare.ts` copies the three PHP modules into `build/` only if their size and SHA-256 equal
`hashes.json`, builds the small modules byte by byte, instantiates each PHP module locally and writes
`build/expected.json`: a 32-bit FNV-1a over pages 64, 580 and 620 (they hold different bytes in all
three modules) and the memory byte length. `local.ts original|boot|render` runs the same sequence in local workerd
and compares both values before anything is uploaded.

## Worker

A plain Worker handler checks the bearer token and forwards one request to a SQLite-backed Durable
Object, so the Free handler's 10 ms CPU cap does not apply to the instantiate. The object builds the
imports from `WebAssembly.Module.imports`, with every function returning 0, creates `env.memory`
with the variant's page count and a maximum of 65,536 pages, instantiates synchronously and returns
the memory byte length. A request with `check=1` also returns the checksum. The empty-memory paths
(`/memory`) time three things for 16, 64 and 128 MiB: `create` (a memory only), `import` (a memory and
a module that imports it) and `own` (a module that declares the memory).

Every reply carries `moduleTag`, `moduleCalls` and `objectCalls`. The tag is random per module
load, so a changed tag on the same object means the module was loaded again. It is not an isolate
identity.

## Requests

Each deploy sends 21 requests to the Durable Object, one at a time, after at most four readiness
polls. No alarms, storage, queues, R2, KV or D1.

| variant  | sequence                                                                                     |
| -------- | -------------------------------------------------------------------------------------------- |
| `a`      | warmup, 4 fresh objects, 4 more requests on the warmup object, then 12 empty-memory requests |
| `b`, `c` | warmup, 10 fresh objects, 10 more requests on the warmup object                              |

The warmup, the last fresh request and the last repeat request carry the checksum, so the checksum
loop stays out of the other timings. Timers do not advance during synchronous CPU in a Worker, so
instantiate cost is the Durable Object invocation's `cpuTime` from `wrangler tail`, joined to the
step by its path and index. Startup and upload size come from the lines Wrangler prints after the
upload response in `deploy.log`.

## Meter and Safety

Three deploys, each at most 25 Worker requests and 21 Durable Object requests, are at most 75 and 63
requests against a Free allowance of 100,000 a day. `deploy.ts` prints the usage meter at the start,
after the first and last step and at the end, snapshots Workers, Durable Object namespaces, KV, R2
and D1 first, retires the class and deletes the Worker, and fails unless the account equals its
baseline. A refused deploy is the result and is not retried. Raw runs stay in `runs/`, which git
ignores.

## Limits

One Durable Object class on one Free account, 4 to 10 requests per group, one day. `cpuTime` is whole
milliseconds from the tail. A reset shows as a changed `moduleTag` or an outcome other than `ok`;
whether the platform reuses an isolate for different object names is not something the reply can
prove.

## Host Boot Path A/B

`hostboot.ts` compares a Durable Object Drupal host with and without a baked image on its own boot path.
The host is a copy of its release, built with the pinned PHP 8.5.2 module, with no KV, D1 or
cron bindings. `scripts/probe/product-bake.ts` reads the host's heap snapshot out of the object's
SQLite file, bakes it, and writes the source that picks the baked path when the live context (pack
generation, enabled modules, driver digest) equals the image's. A cold object is a fresh site name:
the pack migrates twice, a throwaway key and salt are seeded, and the first render returns the body.
Arms alternate inside each round, and `cpuTime` comes from `wrangler tail` joined by a request tag.

```sh
HOSTBOOT_CONTROL_DIR=... HOSTBOOT_BAKED_DIR=... HOSTBOOT_FALLBACK_DIR=... HOSTBOOT_ROUNDS=5 node experiments/bootimage/hostboot.ts
node experiments/bootimage/hostboot-report.ts <run dir> <json>
```

The stop rule is 60,000 rows written, 500 requests or 40 requests per arm, whichever comes first
(`withinBudget`). A refused upload is the result and is not retried. `HOSTBOOT_REBOOT=1` adds a re-boot
step after 30 s idle; it found the interpreter retained, so it produced warm requests only. The
account usage meter did not count these requests, so rows are the sum of each migrate's `rowsWritten`.

## Memory Boundary and Meter

`FOLIO_BOOTIMAGE_MODE=memory FOLIO_BOOTIMAGE_VARIANT=original|render node experiments/deploy.ts bootimage` asks where
a deployed isolate runs out of memory with a live module memory, and what the platform meters for it.
The startup sequence above is unchanged and stays the default.

| deploy | configuration | module              | memory per instantiate |
| ------ | ------------- | ------------------- | ---------------------- |
| `a`    | `a64`         | unmodified          | 1024 pages (64 MiB)    |
| `a`    | `a86`         | unmodified          | 1322 pages (82.6 MiB)  |
| `c`    | `c86`         | baked render module | 1322 pages (82.6 MiB)  |

`/inst?m=NAME&pages=N&keep=1` instantiates with `N` pages (the registered count when omitted) and keeps
the memory in the object. `/ballast?mib=8` then allocates one filled `Uint8Array` of that size per
request, keeps it referenced, and returns `ballastBytes`, `memoryBytes` and their sum `liveBytes`. A
request on an object that holds nothing answers 409 with `held: false`, which is how a reset that
happens between two requests shows up. A reset during a request would show as a failed request.

Per configuration the driver (`driveMemory` in `plan.ts`) takes three fresh object names, alternating
the configurations of a deploy, and sends one step per request up to 40, stopping at the first reply
that is not a 200 with `held: true` and sending one more request to see the new module tag. The largest
`liveBytes` of an answered step is that object's boundary. An object whose first reply shows
`moduleCalls` above `objectCalls` shared its module instance with an earlier object and is left out of
the range. Each configuration also gets three more objects that only instantiate, four requests each.

The meter comes from `durableObjectsPeriodicGroups` (`activeTime`, `cpuTime`, `duration`,
`exceededMemoryErrors`, by object name). Its dataset lags about 8 minutes, so `deploy.ts` waits once
after the requests, polls until every object has a row and two reads agree, saves the reply to
`periodic.json`, and only then deletes the Worker. `analyze.ts` reports GB-s per active second and per
request for the instantiate-only objects and `exceededMemoryErrors` for the boundary objects.

The request bound is 1 + 40 requests per boundary object and 12 per configuration for the meter, so 270
Durable Object requests for deploy `a` and 135 for deploy `c`, plus at most 4 readiness requests each.
Stopping at the reset usually sends far fewer. No storage, alarms, queues or other bindings.
`node experiments/bootimage/local.ts original|render memory 3` runs the same driver in local workerd with 3 steps.

The 1322-page memory is 86,638,592 bytes: 86.6 MB and 82.6 MiB. A reset showed up between two requests
in all nine boundary runs: the request that crossed the limit answered 200, and the next request found
`held: false` under a new module tag. The largest `liveBytes` is therefore the total at the request
that crossed it, and the limit lies in the 8 MiB step before. `wrangler tail` is a second instrument and
a sampled one (it can miss invocations or fail to connect), so the boundary does not depend on it.
`periodic.json` is the reply read by the deploy and `periodic-late.json` a later read of the same
dataset, which kept adding rows and activeTime for a few minutes after the deploy ended. A re-read about
40 minutes after deploy `a` returned none of its rows (one observation), so the capture has to be taken
while the rows are fresh.

## Baked Render Image as Static Assets

The render image does not fit as data segments: the bundle was 64.41 MiB and the upload was refused
at 63.9 MiB. The same pages ship as files instead: `product-bake.ts assets <image> <dir> 64` writes
`index.json` (page size, memory pages, and per file the page numbers and a 32-bit hash of each page)
and `c000.bin` and on (up to 64 pages, 4 MiB, per file; the documented limit is 25 MiB per asset
file). The Durable Object reads its own `ASSETS` binding, as it does for the pack, instantiates the
unmodified module into a memory of the image's size, and writes each file's pages into the memory view
before the glue runs, one file in flight. A smaller page list is the same format with fewer pages.
`HOSTBOOT_VERIFY=1` hashes every page as it lands; `/hostdeliver?check=1` hashes every page of the finished
memory. `HOSTBOOT_DELIVER=1` adds three delivery probes to `hostboot.ts`. Without a bundled second module a
context mismatch boots the plain module into a memory of the usual size. The clock inside a Worker only
advances at I/O, so per-file copy time reads 0 there; the Durable Object invocation's `cpuTime` from
`wrangler tail` is the instrument for fetch plus copy.

## Stale State of a Baked Image

`stale.ts` renders the front page of a cold object from the baked image and from the plain module
after the object's database has been edited, and compares the normalized bodies. Per arm and case it
migrates, seeds, renders, edits through Drupal's own config and entity APIs (`/hostphp`), renders warm,
drops the interpreter (`/hostdrop`) and renders cold. The image's context key is the pack generation,
the module fingerprint and the driver digest; none of them changes when a config row changes. A
rename of the site leaves the baked cold boot serving the old name in the page title (config objects
read at bake time stay in the heap). A digest of the `config` table rows (175 rows, 1 to 6 ms locally)
as a second key sends the edited site to a plain boot with the correct body; the site then loses the
image's saving. [stale.json](../../results/boot/eligibility/stale.json) holds both runs.

`HOSTBOOT_BOOTPHASE=1` adds, per object after the first request, a re-boot request through `/bootphase`
(which drops the interpreter; its `alreadyBooted` and the boot path come back in the reply), and for
the first two objects of each arm a drop, a boot-only `/php` and a warm render, each tagged so its
`cpuTime` joins from the tail. Config rows are the second key of the baked image: the digest of the
`config` table is compared at boot and a mismatch boots the plain module.

`HOSTBOOT_ARMS=control=<dir>,seq=<dir>,par=<dir>` names any number of arms and the report compares each with
the control. The image loader keeps `HOSTBOOT_K` file fetches in flight (a worker per slot takes the next
file and writes its pages into the memory view as soon as the file arrives); each in-flight file is one
4 MiB buffer of extra isolate memory. A free-plan account that has used its daily Durable Object rows
makes every new object answer 503 with the exception "Exceeded allowed rows written in Durable
Objects free tier" in the tail; `hostboot.ts` now logs the body of a failed readiness check.

`FOLIO_CLOUDFLARE_ACCOUNT_ID` and `FOLIO_CLOUDFLARE_API_TOKEN` select the account `credentials()` returns;
without them the `FREE_CLOUDFLARE_*` pair is used. `HOSTBOOT_IDLE=1` sends one request per object after 30, 90, 150 and 90 s of idle (by
round), without touching the object in between, and records `warmInterpreter`, a module-level tag and
boot counter, and a per-instance tag. A new module tag with a boot counter back at 1 is an evicted
isolate; a new instance tag with the module tag kept is a hibernated object whose isolate survived.

## Host Boot on PHP 8.5.12

The same A/B on the 8.5.12 interpreter (`php8.5.tuned.wasm`, 14,011,467 bytes, and its tuned glue; both digests are recorded in
every results file). This module imports its memory, keeps four mutable globals, and its glue seals the
`Module.cfw*` handles and roots handle 1 at `__cfwRoot`. Replay therefore goes through the host's own
`replayHandles`, which seals and roots the handles, and the import census of the host stays at zero problems.

The globals are read through the getter exports (`emscripten_stack_get_current`,
`emscripten_stack_get_base`, `emscripten_stack_get_end`, `getTempRet0`). `getterGlobals` in
`scripts/probe/product-bake.ts` finds the wasm global each getter reads by looking at the getter's body, so
`bake` can hand the changed ones (the stack limits) to `bakeModule`. An asset-delivered image runs the
unmodified module, so its loader calls `emscripten_stack_init`, which recomputes the stack limits boot had
set, and refuses the boot when a getter then differs from the value recorded at capture.

`product-bake.ts source` takes `assets=<index path>` and `config=<digest>` after the fallback argument. The
host's `.assetsignore` denies by default, so the image directory needs its own `!/hostboot/` line, or the
object's read of `hostboot/index.json` answers 404 and the boot waits on an instantiate that never finishes.
`HOSTBOOT_MAX_ROWS`, `HOSTBOOT_MAX_REQUESTS` and `HOSTBOOT_MAX_ARM_REQUESTS` lower the stop rule of
`hostboot.ts`; a value above the default is refused (`budgetFromEnv`).

```sh
HOSTBOOT_ARMS=control= HOSTBOOT_BOOTPHASE=1 HOSTBOOT_PHASE_ROUNDS=0 HOSTBOOT_IDLE=1 \
  HOSTBOOT_MAX_ROWS=36500 HOSTBOOT_MAX_REQUESTS=300 < dir > ,par= < dir > HOSTBOOT_ROUNDS=5 node experiments/bootimage/hostboot.ts
```

[php-8512.json](../../results/boot/loader/php-8512.json) holds the local proof: normalized bodies of four paths equal
between a plain cold boot and a cold boot from the image, the CSRF token equal to the plain object seeded
with the same key and different from one seeded with the sentinel, first `mt_rand` values that differ across
two cold baked objects, a context mismatch that boots the plain module with the same body, and the stale
matrix of `stale.ts`. [result.json](../../results/boot/deployed-serve/result.json) is the deployed run: 5 objects per arm
on one deploy per arm, the control on the plain module and the host's own boot path (its heap restore
refused for lack of a snapshot, so a plain boot), the other arm on the image with 4 files in flight.

`/bootphase` always builds a second kernel from the database, and a baked object's database lacks the
persistent cache and state rows the image already holds in memory (the theme registry, the discovery
caches, `system.theme.files`), because its first request never wrote them. The first `/bootphase` of a
baked object therefore reads about 2.4 MB and writes about 1 MB through the bridge, the work a plain
object did in its first request, and later ones read 1.2 MB like the control. The host's own path after an
eviction is a drop followed by an ordinary render, and `HOSTBOOT_SERVE=1` measures it: each object gets
`/hostdrop` and then a tagged `/hostbody`, recorded as the `-serve` arm of the summary, before the
`/bootphase` step. It adds two requests per object, so the per-object request need rises from 6 to 8.

## Serve Path After an Eviction

`HOSTBOOT_SERVE=1` adds the path the host takes after an eviction to each object: `/hostdrop`, then an ordinary
`/hostbody`, recorded as the `-serve` arm. A run on a Free account whose daily rows were used up ended at the
readiness check: the first statement of a new object threw "Exceeded allowed rows written in Durable Objects
free tier." and the host answered its retry page. The same run on a paid account, one deploy per arm, 4 objects
per arm, alternating:

| step               | control cpuTime ms median [min, max] | baked cpuTime ms   | control wall ms | baked wall ms        | bridge out, control | bridge out, baked |
| ------------------ | ------------------------------------ | ------------------ | --------------- | -------------------- | ------------------- | ----------------- |
| first request      | 3,822 [3,699, 3,897]                 | 1,035 [815, 1,078] | 4,521           | 2,152 [1,707, 7,072] | 2,310,827           | 10,131            |
| serve after drop   | 989 [970, 1,092]                     | 555 [413, 707]     | 1,112           | 1,014 [719, 1,862]   | 1,196,078           | about 161,430     |
| first `/bootphase` | 1,028 [906, 1,334]                   | 1,016 [876, 1,497] | 1,206           | 1,821 [1,258, 5,764] | 1,194,833           | about 2,415,280   |

The serve step is the cost the host pays after an eviction with the interpreter already gone, and the baked arm
spends 44 percent less cpuTime on it and moves a seventh of the bridge bytes. The first `/bootphase` of a baked
object matches the control in cpuTime and is slower in wall, for the reason in the previous section. Four idle
probes found real evictions (new module tag, boot counter 1): cold boots of the control cost 1,751 and 2,035 ms of
cpuTime, and the two baked ones 682 and 799 ms through the image. Every request answered 200, all 138
invocations were `ok`, and no request took more than 7.1 s.

The runner is stricter on a paid account. `HOSTBOOT_STRICT=1` ends the run at the first 5xx, failed or slow
request (`HOSTBOOT_MAX_REQUEST_MS`), `HOSTBOOT_GUARD_ROWS` and `HOSTBOOT_GUARD_GBS` end it when the account meter grows
past a limit since its first read (`HOSTBOOT_METER_SINCE` sets the first day of the month it sums), and two failed
meter reads in a row end it. `HOSTBOOT_GATE_ROUNDS=2` continues to the full round count only if no outcome
other than `ok` appeared and every baked serve ratio is below 1; `HOSTBOOT_IDLE_FROM` starts the idle probes at a
later round. The run keeps an inventory of Workers, Durable Object namespaces, KV, R2 and D1 (names and modified
times) before and after, and the report lists a difference that is not the run's own as a short hash. The meter's
rows and requests lag the traffic by several minutes.
