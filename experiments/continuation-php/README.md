# Continuation PHP

Does an interrupt park in a PHP build keep the stack, memory and output exact across stops and
restores? The build carries the interrupt-park patch and runs under the event protocol of
`@gmitch215/folio/continuation`. Everything here is local: Node 26 drives the module, and the `P2`
arm runs the same protocol in a local Durable Object under `wrangler dev`. Nothing in this folder
deploys.

## Files

| File                   | Role                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `workload.php`         | the guest program, as eval'd source with no open tag                                       |
| `prepare.mjs`          | copies the module from `FOLIO_PHP_WASM_DIR/i5b` into `build/` and checks its hash          |
| `lib.mjs`              | the protocol shared by the Node arm and the Durable Object: budgets, checkpoints, restores |
| `run.mjs`              | the `P0` and `P1` arms                                                                     |
| `drive-p2.mjs`         | starts `wrangler dev` and drives the `P2` arm                                              |
| `worker.mjs`           | the `Job` Durable Object that `P2` runs in, with `wrangler.jsonc`                          |
| `classify-globals.mjs` | lists the `global.get` and `global.set` sites of each mutable global in a module           |
| `check-budget.mjs`     | budget rules of the park protocol against a fake instance, with no Wasm                    |
| `check-memory.mjs`     | peak extra allocation of the checkpoint path, sampled after a collection                   |

`workload.php` prints progress lines and a checksum. It has user-function calls at depth three,
string and array work, and two refused regions: an `array_map` with a closure and a generator body.

## Arms

| Arm  | What it runs                                                                     |
| ---- | -------------------------------------------------------------------------------- |
| `P0` | the workload without parks; records the reference output                         |
| `P1` | the event protocol in memory, with budget and signal parks, commits and restores |
| `P2` | the same protocol in a local Durable Object with SQLite checkpoints              |

## Running

```sh
FOLIO_PHP_WASM_DIR=<dir with i5b/php8.5-worker.mjs and .wasm> node experiments/continuation-php/run.mjs P0
FOLIO_PHP_WASM_DIR=<dir> node experiments/continuation-php/run.mjs P1
FOLIO_PHP_WASM_DIR=<dir> node experiments/continuation-php/drive-p2.mjs
node experiments/continuation-php/classify-globals.mjs <module.wasm>
node experiments/continuation-php/check-budget.mjs
node --expose-gc experiments/continuation-php/check-memory.mjs
```

`prepare.mjs` refuses any module whose sha256 does not start with `9031f413`. `P1` reads
`runs/P0-output.txt`, so run `P0` first. Raw output and JSON records go to `runs/`, and both `runs/` and
`build/` are git-ignored.

## Checks

- `P0` the workload finishes and ends with the checksum line.
- `P1` the output equals the `P0` output byte for byte.
- `P1` the stack pointer, stack base and stack end read through the module's exports match their
  post-init values at every park.
- `P1` each park reason matches the injected signal: `SIGNAL` for events with a raised word, `BUDGET`
  otherwise.
- `P1` an event that counted refusals parks after the `array_map` region.

## Event Protocol

A budget park commits memory at the end of its event. A signal park does not commit, and the next
event on the same instance commits first. Memory is hashed per 64 KiB page, and each 1 MiB group
whose page hashes changed is copied into the store.

## Limits

- The strict check for the generator region is not met in the recorded runs. The study README states
  the reading.
- The runs are local. The deployed runs of the same workload are in
  [Continuation Across Invocations](../../TECHNICAL_REPORT.md#continuation-across-invocations), and their
  per-event records are not exported to `results/`.
- A refused stretch longer than one event never reaches an admissible poll inside that event.

Results are in [php-park](../../results/continuation/php-park/README.md).
