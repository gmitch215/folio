# Memory

Linear memory that outlives one call: page directories, growth limits, boot images and checkpoints.

- `pages.ts`: `PageDirectory`, immutable page versions with bounded leases. Exported by `./memory`.
- `growth-governor.ts`: `governGrowth`, which refuses `memory.grow` past a byte cap. Exported by
  `./memory`.
- `bake.ts`: captures a booted memory as an image, checks it against a module, and bakes it into
  the module. Exported by `./boot`.
- `continuation.ts`: checkpoints a run across invocations in Durable Object SQLite. Exported by
  `./continuation`.
- `imports.ts`, `iteration-layout.ts`, `lease.ts`: internal helpers for imported memory limits, the
  arena layout shared with iteration and managed execution, and a verified page cache.

Portable: no Node imports. `bakeModule` loads binaryen on demand; the rest compile no Wasm.
