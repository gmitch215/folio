# Baked Boot Images on a FREE Backend

The question: what does the deployed plane do with a 13.4 MB PHP Wasm module that carries its booted
memory as initial data? Two baked modules come from `scripts/probe/boot-image.ts`: 20.7 MB with the
7.3 MB boot delta and 61.0 MB with the 47.6 MB after-first-render delta. A render from them still
needs the JS-side state replayed, so this probe measures the platform cost of carrying and
instantiating them and nothing about rendering.

## Deploys

Three modules together pass the 64 MiB uncompressed bundle, so each variant is its own deploy
(`FOLIO_BOOTIMAGE_VARIANT=a|b|c node experiments/deploy.ts bootimage`).

| variant | modules in the bundle                                                | memory per instantiate |
| ------- | -------------------------------------------------------------------- | ---------------------- |
| `a`     | the unmodified module, three own-memory modules, one memory importer | 1024 pages             |
| `b`     | the baked boot module                                                | 1024 pages             |
| `c`     | the baked render module                                              | 1322 pages             |

`prepare.ts` copies the three PHP modules into `build/` only if their size and SHA-256 equal
`hashes.json`, builds the small modules byte by byte, instantiates each PHP module locally and writes
`build/expected.json`: a 32-bit FNV-1a over pages 64, 580 and 620 (they hold different bytes in all
three modules) and the memory byte length. `local.ts a|b|c` runs the same sequence in local workerd
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

`s34.ts` compares a Durable Object Drupal host with and without a baked image on its own boot path.
The host is a scratch copy of its release, built from the pinned PHP 8.5.2 module, with no KV, D1 or
cron bindings. `scripts/probe/product-bake.ts` reads the host's heap snapshot out of the object's
SQLite file, bakes it, and writes the source that picks the baked path when the live context (pack
generation, enabled modules, driver digest) equals the image's. A cold object is a fresh site name:
the pack migrates twice, a throwaway key and salt are seeded, and the first render returns the body.
Arms alternate inside each round, and `cpuTime` comes from `wrangler tail` joined by a request tag.

```sh
S34_CONTROL_DIR=... S34_BAKED_DIR=... S34_FALLBACK_DIR=... S34_ROUNDS=5 node experiments/bootimage/s34.ts
node experiments/bootimage/s34-report.ts <run dir> <json>
```

The stop rule is 60,000 rows written, 500 requests or 40 requests per arm, whichever comes first
(`withinBudget`). A refused upload is the result and is not retried. `S34_REBOOT=1` adds a re-boot
step after 30 s idle; it found the interpreter retained, so it produced warm requests only. The
account usage meter did not count these requests, so rows are the sum of each migrate's `rowsWritten`.

## Memory Boundary and Meter

`FOLIO_BOOTIMAGE_MODE=memory FOLIO_BOOTIMAGE_VARIANT=a|c node experiments/deploy.ts bootimage` asks where
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
`node experiments/bootimage/local.ts a|c memory 3` runs the same driver in local workerd with 3 steps.

The 1322-page memory is 86,638,592 bytes: 86.6 MB and 82.6 MiB. A reset showed up between two requests
in all nine boundary runs: the request that crossed the limit answered 200, and the next request found
`held: false` under a new module tag. The largest `liveBytes` is therefore the total at the request
that crossed it, and the limit lies in the 8 MiB step before. `wrangler tail` is a second instrument and
a sampled one (it can miss invocations or fail to connect), so the boundary does not depend on it.
`periodic.json` is the reply read by the deploy and `periodic-late.json` a later read of the same
dataset, which kept adding rows and activeTime for a few minutes after the deploy ended. A re-read about
40 minutes after deploy `a` returned none of its rows (one observation), so the capture has to be taken
while the rows are fresh.
