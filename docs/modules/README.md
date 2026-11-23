# Modules

Folio has six subpaths. Each one names a runtime boundary or a feature, and each has a page with an
overview, a smallest working example, the options that come next, its limits and links to the
reference.

| Import                          | Runs on                     | Purpose                                                                                                                | Page                                                                                    |
| ------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `@gmitch215/folio`              | Node                        | Parallel execution, instance checkpoints, the execution host, task and slice pools, folds, certificates and the router | [Core](core.md), [Pools](pools.md), [Folds and Certificates](folds-and-certificates.md) |
| `@gmitch215/folio/workers`      | Workers and Durable Objects | Managed execution on Durable Object lanes and the portable client of the execution host                                | [Workers](workers.md)                                                                   |
| `@gmitch215/folio/browser`      | Browsers without JSPI       | One counted-loop call on shared memory across Web Workers                                                              | [Browser](browser.md)                                                                   |
| `@gmitch215/folio/memory`       | Portable                    | The growth governor, page directories and leases, and elastic regions                                                  | [Memory](memory.md)                                                                     |
| `@gmitch215/folio/boot`         | Portable                    | Baked boot images that start a module from a booted heap                                                               | [Boot](boot.md)                                                                         |
| `@gmitch215/folio/continuation` | Portable                    | Wasm guests across Durable Object alarm events, with page-hash checkpoints in SQLite                                   | [Continuation](continuation.md)                                                         |

Subpaths from 1.1 that are not in this table are no longer exported. The CHANGELOG lists where each
of their names moved.

## Which Module Do I Need

Start from what you have and what you want.

- **A Wasm program on Node and you want several cores.** Use [Core](core.md). `Folio.run` finds the
  regions and keeps the serial result.
- **Independent jobs you can name.** Use the task pool in [Pools](pools.md). For records in one
  memory that you declare independent, use the slice pool.
- **One checksum or cipher stream over a large input.** Use the folds in
  [Folds and Certificates](folds-and-certificates.md).
- **A record loop and you want proof that its scratch is private.** Use an ownership certificate, or
  let the router choose, in [Folds and Certificates](folds-and-certificates.md).
- **Execution inside Workers and Durable Objects.** Use [Workers](workers.md). Managed Workers
  cannot share physical memory, so that backend copies snapshots or learned byte ranges.
- **A browser page.** Use [Browser](browser.md) when the runtime has no JSPI.
- **A guest that must not exceed a memory size.** Use the growth governor in [Memory](memory.md).
- **A module that boots slowly.** Bake the booted heap into the module with [Boot](boot.md).
- **A job that needs more CPU than one Durable Object event allows.** Use
  [Continuation](continuation.md).
- **A private instance that must reset between jobs.** Use the instance checkpoints in
  [Core](core.md).

[Getting Started](../getting-started.md) runs the first program,
[Configuration](../configuration.md) lists every option, and [Limits](../limits.md) lists what each
module does not do.
