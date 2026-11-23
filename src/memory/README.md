# Memory

Linear memory that outlives one call: page directories, growth limits, boot images and checkpoints.

- `pages.ts`: `PageDirectory`, immutable page versions with bounded leases. Exported by `./memory`.
- `growth-governor.ts`: `governGrowth`, which refuses `memory.grow` past a byte cap. Exported by
  `./memory`.
- `elastic.ts`: `ElasticRegion` and `AsyncElasticRegion`, a byte range larger than the window of
  chunk frames that holds it. Misses fetch from a holder; write-back raises a chunk's version.
  Exported by `./memory`.
- `elastic-sql.ts`: `sqlHolder`, a holder over one Durable Object SQL table. Exported by `./memory`.
- `elastic-peer.ts`: `peerHolder` and `peerStore`, a holder over peer objects. Exported by `./memory`.
- `bake.ts`: captures a booted memory as an image, checks it against a module, and bakes it into
  the module. Exported by `./boot`.
- `continuation.ts`: checkpoints a run across invocations in Durable Object SQLite. Exported by
  `./continuation`.
  `runSlice` writes an attempt row (event number and budget) and flushes it with `storage.sync()`
  before the guest runs. An event that starts in a new isolate and finds an open attempt with no
  commit after it knows the last attempt was killed. It halves that budget, never below
  `initialBudget`, stops doubling and returns the halving as `lost`. A kill that lands before the
  flush returns leaves no row, so that event retries at the same budget. A signal stop or a cut closes
  the attempt after it re-arms.
- `imports.ts`, `iteration-layout.ts`, `lease.ts`: internal helpers for imported memory limits, the
  arena layout shared with iteration and managed execution, and a verified page cache.

Portable: no Node imports. `bakeModule` loads binaryen on demand; the rest compile no Wasm.
