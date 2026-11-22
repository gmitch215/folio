# Growth Governor

`governGrowth` in `src/growth-governor.ts` wraps the `grow` method of one `WebAssembly.Memory` and refuses any grow whose final size would pass a byte cap. This experiment checks whether that cap makes an oversized request fail cleanly in an Emscripten guest, instead of letting the memory grow past its budget.

The guest is a PHP 8.5 interpreter built with Emscripten (the module and glue are inputs). Each arm boots it with opcache off, `memory_limit=96M` and a `disable_functions` list, runs a 64 MiB string allocation, and records the outcome. The `open` arm is the control.

## Arms

| Arm               | Cap                 | Request                                    | Expected                                                      |
| ----------------- | ------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| `open`            | none                | 64 MiB `str_repeat`                        | Completes. Control.                                           |
| `capped`          | 104 MiB (109051904) | 64 MiB `str_repeat`                        | Refused grows; `[error] Out of memory` and exit status 1.     |
| `capped-fit`      | 160 MiB (167772160) | 64 MiB `str_repeat`                        | Completes with a matching sha256; memory stays under the cap. |
| `capped-trycatch` | 104 MiB (109051904) | 64 MiB `str_repeat` inside `try` / `catch` | Same as `capped` if PHP's `catch` receives the refusal.       |

## Running

Run from the folio root. The harness loads the `.ts` source directly. Tested on Node 22.23.3.

```sh
PHP_WASM=/path/to/php8.5.wasm PHP_GLUE=/path/to/php8.5-glue.mjs PHP_BASE=/path/to/PhpBase.mjs \
  node experiments/growth-governor/php-grow-cap-check.mjs capped 1
```

The second argument is a run label. The output is written to `OUT/<arm>-<label>.json`, and the label defaults to `1`.

| Variable    | Default                                      | Purpose                                                             |
| ----------- | -------------------------------------------- | ------------------------------------------------------------------- |
| `PHP_WASM`  | required                                     | Emscripten PHP module (`.wasm`).                                    |
| `PHP_GLUE`  | required                                     | Emscripten glue of that module (`.mjs`, the module factory).        |
| `PHP_BASE`  | required                                     | `PhpBase.mjs` from the public `php-wasm` package.                   |
| `CAP_BYTES` | 109051904 for `capped` and `capped-trycatch` | Cap in bytes. `open` and `capped-fit` use fixed caps and ignore it. |
| `OUT`       | `runs/` in this folder                       | Output directory. `experiments/*/runs/` is git-ignored.             |

## Results

### Request-Size Cap

This check compared each request's size with the cap before the glue ran. `php-grow-cap-check.mjs` runs the grow cap below instead.

| Arm                                           | Refusals                              | Result                                                     | Memory (bytes)         | After the run                             |
| --------------------------------------------- | ------------------------------------- | ---------------------------------------------------------- | ---------------------- | ----------------------------------------- |
| `open`                                        | 0                                     | Completes; sha256 matches                                  | 100663296 to 120848384 | Not needed                                |
| `capped` (cap 109051904)                      | 0                                     | Completes; the glue grows to 120848384, above the cap      | 120848384              | Alive; shutdown and startup ok; `1+1` = 2 |
| `capped-1` (16 MiB fill, then 64 MiB request) | 2 (requested 124325888 and 124329984) | `[error] Out of memory`; thrown `ExitStatus` with status 1 | 100663296              | Alive; shutdown and startup ok; `1+1` = 2 |

The request-size check passed the 107548672-byte request, and the glue's overgrowth then took memory above the cap.

### Grow Cap

The cap applies to every `memory.grow` call, including the glue's overgrowth. A refused grow throws a `RangeError` inside the glue, and the glue retries at a smaller size.

| Arm               | Cap (bytes) | Refused grow targets (bytes) | PHP output  | Final memory (bytes) | Outcome                                       |
| ----------------- | ----------- | ---------------------------- | ----------- | -------------------- | --------------------------------------------- |
| `open`            | none        | none                         | none        | 120848384            | Completes; sha256 matches the host digest     |
| `capped`          | 109051904   | 120848384, 110755840         | none        | 107610112            | Completes; the third attempt, 107610112, fits |
| `capped-trycatch` | 109051904   | 120848384, 110755840         | `completed` | 107610112            | Completes; the `catch` block never runs       |
| `capped-fit`      | 167772160   | none                         | none        | 120848384            | Completes; sha256 matches the host digest     |

In both capped arms at this cap, the instance survived shutdown, startup and `1+1`, which returned 2.

### Grow Cap at 100 MiB

The rerun sets `CAP_BYTES=104857600`.

| Arm               | Refused grow targets (bytes), each attempt twice      | PHP output              | Outcome                                                           | Final memory (bytes) |
| ----------------- | ----------------------------------------------------- | ----------------------- | ----------------------------------------------------------------- | -------------------- |
| `capped`          | 120848384, 110755840, 107610112 (6 refusals in total) | `[error] Out of memory` | `_run` throws `ExitStatus` with status 1; PHP `catch` not entered | 100663296            |
| `capped-trycatch` | 120848384, 110755840, 107610112 (6 refusals in total) | `[error] Out of memory` | Same as `capped`                                                  | 100663296            |

After the run, shutdown, startup and `1+1` (2) pass in both arms, and memory stays at the boot size. With the `try` wrapper, the first request is 107589632 bytes instead of 107548672. The glue's refused targets are the same.

### Glue Growth

The glue's `emscripten_resize_heap` tries three sizes in turn: the old heap size times 1.2, times 1.1 and times 1.05. Each size is capped at the request plus 96 MiB, never falls below the request, and is aligned up to 64 KiB. The glue calls `memory.grow` with a fractional page count, and native grow truncates it. The governor truncates the same way.

## Limits

- One PHP module was run; its memory is defined by the module (it does not import one), so the harness guards the exported memory.
- In this run, PHP's `catch` did not see the refusal. The request exits with status 1, which the host sees as a thrown `ExitStatus`, not a trap.
- The governor covers WebAssembly memory only. JS-side memory is not guarded.
- The harness boots with the ini lines in `php-grow-cap-check.mjs` only and runs no host-side boot shims.
- Results come from Node 22.23.3 only.

## Reproducing

```sh
export PHP_WASM=/path/to/php8.5.wasm
export PHP_GLUE=/path/to/php8.5-glue.mjs
export PHP_BASE=/path/to/PhpBase.mjs
nvm use 22
for n in 1 2; do
  node experiments/growth-governor/php-grow-cap-check.mjs open $n
  node experiments/growth-governor/php-grow-cap-check.mjs capped-fit $n
  node experiments/growth-governor/php-grow-cap-check.mjs capped 104mib-$n
  node experiments/growth-governor/php-grow-cap-check.mjs capped-trycatch 104mib-$n
  CAP_BYTES=104857600 node experiments/growth-governor/php-grow-cap-check.mjs capped 100mib-$n
  CAP_BYTES=104857600 node experiments/growth-governor/php-grow-cap-check.mjs capped-trycatch 100mib-$n
done
cmp experiments/growth-governor/runs/open-1.json experiments/growth-governor/runs/open-2.json
```
