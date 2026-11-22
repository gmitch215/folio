# continuation-php

A PHP build with the interrupt-park patch, run under the event protocol used for continuations.
Local only: Node 26 drives the module, and nothing here deploys. The `P2` arm runs the same protocol
in a local Durable Object under `wrangler dev`.

## Files

- `workload.php` the guest program, as eval'd source with no open tag. It prints progress lines and a
  checksum, has user-function calls at depth three, string and array work, and two refused regions:
  an `array_map` with a closure and a generator body.
- `classify-globals.mjs` reads the code section of a wasm module and lists the `global.get` and
  `global.set` sites of each mutable global. Writes `runs/globals.json`.
- `run.mjs` the arms. `P0` runs the workload without parks and records the reference output.
  `P1` runs the event protocol with budget and signal parks, with commits and no restores.
- `drive-p2.mjs` and `worker.mjs` the `P2` arm: the same protocol in a Durable Object.

## Run

    FOLIO_PHP_WASM_DIR=<dir with i5b/php8.5-worker.mjs and .wasm> node run.mjs P0
    FOLIO_PHP_WASM_DIR=<dir> node run.mjs P1
    node classify-globals.mjs <module.wasm>

`prepare.mjs` copies the artifact from `FOLIO_PHP_WASM_DIR/i5b` into `build/` and refuses any wasm
whose sha256 does not start with `9031f413`. `P1` reads `runs/P0-output.txt`, so run `P0` first. Raw
output and JSON records go to `runs/`. Both directories are git-ignored.

## Checks

- `P0` the workload finishes and ends with the checksum line.
- `P1` the output equals the `P0` output byte for byte.
- `P1` the stack pointer, stack base and stack end read through the module's exports match their
  post-init values at every park.
- `P1` each park reason matches the injected signal: `SIGNAL` for events with a raised word, `BUDGET`
  otherwise.
- `P1` an event that counted refusals parks after the `array_map` region. The strict check for the
  generator region is not met in the recorded runs; the study README states the reading.

## Event Protocol

A budget park commits memory at the end of its event. A signal park does not commit, and the next
event on the same instance commits first. Memory is hashed per 64 KiB page, and each 1 MiB group
whose page hashes changed is copied into the store.

Results are in `results/continuation/php-park`.
