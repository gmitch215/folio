# Browser

Counted-loop parallelism in browsers. `BrowserFolio` instantiates a precompiled module, attaches
dedicated module workers to a shared `WebAssembly.Memory`, and runs a loop's iterations as regions
across them. Work that the compiler cannot prove independent runs serially on the original instance.

- `index.ts`: `BrowserFolio`, the pool and runner, and the program and option types.
- `worker.ts`: the worker entry. `BrowserFolio` loads it by URL from the built `dist/browser/`
  folder, so the file is part of the published output.

The `./browser` subpath exports this folder through `src/browser.ts`. Workers attach only when
`SharedArrayBuffer` is available, which needs a cross-origin isolated page. Node has no global
`Worker`, so Node callers pass a `workerFactory` that returns a message port.
