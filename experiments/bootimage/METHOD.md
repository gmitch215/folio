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
