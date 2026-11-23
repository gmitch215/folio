# Boot Images

A Wasm interpreter pays for its boot on every cold start, and the heap state it builds is the same each time. This page covers the studies that moved that state into the compiled module and measured the saving, the cost of delivering it, and what the image gets wrong.

## Question

How much of a cold start does a baked image remove, what does it cost to deliver on the edge, and when does it serve the wrong state?

## Instruments

| Study                                                                                                          | What it measures                                                     | Where                    |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------ |
| [php-852](https://github.com/gmitch215/folio/blob/master/results/boot/php-852/README.md)                       | image anatomy, delivery and the open-plus-render saving on PHP 8.5.2 | Mac, M2 Pro, Node 26.8.2 |
| [php-8512](https://github.com/gmitch215/folio/blob/master/results/boot/php-8512/README.md)                     | the same on PHP 8.5.12                                               | Mac                      |
| [replay-852](https://github.com/gmitch215/folio/blob/master/results/boot/replay-852/README.md)                 | secrets in the image and the rekey step                              | Mac                      |
| [lifecycle](https://github.com/gmitch215/folio/blob/master/results/boot/lifecycle/README.md)                   | 45 Drupal executions from compile through first render               | Mac, 15 paired rounds    |
| [configurations](https://github.com/gmitch215/folio/blob/master/results/boot/configurations/README.md)         | 13 configurations in four arms on a Drupal host                      | Mac                      |
| [initializer-repeat](https://github.com/gmitch215/folio/blob/master/results/boot/initializer-repeat/README.md) | the 21 corpus initializers                                           | Ryzen 9 9900X, quiet     |
| [bootimage](https://github.com/gmitch215/folio/blob/master/experiments/bootimage/README.md)                    | delivery as data segments and as static assets on Durable Objects    | Free and Paid plans      |

The library path is `captureImage`, `bakeModule` and `applyImage` in `@gmitch215/folio/boot`. Everything below is the PHP 8.5.2 module (13,401,751 bytes) with a stock Drupal site unless it says deployed or 8.5.12.

## Design

A booted context's memory is captured, the 64 KiB pages that differ from a fresh instance are written into a rewritten module as active data segments with binaryen, and instantiating the module initializes memory from them with no database read and no inflate. A memory image does not carry state that lives in JavaScript. Rendering from it needed four things rebuilt: the handle table that `pib_init` creates, the open `/dev/urandom` descriptor, and four registered handles. Boot changes no global except the stack pointer's value, which equals its initial value, and no table slot.

| Arm                      | What it holds                                              |
| ------------------------ | ---------------------------------------------------------- |
| Plain boot               | the unmodified module, booted on every start               |
| Baked after boot         | the 111 pages (7.27 MB) that differ after boot             |
| Baked after first render | the 727 pages (47.6 MB) that differ after the first render |

After boot the memory is 67,108,864 bytes with 174 nonzero pages (11.4 MB). After the first render it is 86,638,592 bytes with 790 nonzero pages (51.8 MB). Deflated at 200,000-byte rows the two deltas are 1.7 MB and 14.4 MB.

## Results

### The Saving, Locally

Open plus first render, first context in a fresh process, median of 10 processes per arm:

| Arm                      |          ms (min to max) |        Saved | Second context |
| ------------------------ | -----------------------: | -----------: | -------------: |
| Plain boot               | 1,246.6 (1,209 to 1,375) |              |        1,033.7 |
| Baked after boot         | 1,172.8 (1,142 to 1,250) |        74 ms |          991.5 |
| Baked after first render |       372.7 (361 to 393) | 874 ms (70%) |          276.7 |

The boot image saves little because the first render is 53 ms slower with it: functions that the kernel boot used to compile now compile during the render. The after-render image removes the first render's cost (884 ms to 127 ms). What stays is the SQLite seed, the JS imports, the mounts and the bridge, about 215 ms. Renders equal a booted context's normalized sha256 in 80 of 80 per image.

Instantiating the baked module takes 4.8 ms (boot image) and 9.1 ms (after-render image) against 3.7 ms unmodified. Reading the same images as 200,000-byte deflated rows from an in-memory `node:sqlite` file, inflating and copying takes 62 ms and 302 ms.

On PHP 8.5.12 (module sha256 `3fb16024...b80ce`, 14,011,467 bytes) the page counts equal the 8.5.2 ones: 107 delta pages after boot and 771 after the first render.

| Arm                      | 8.5.12 ms | Saved |
| ------------------------ | --------: | ----: |
| Plain boot               |   1,343.7 |       |
| Baked after boot         |   1,268.8 |    6% |
| Baked after first render |     349.7 |   74% |

The 8.5.12 module has four mutable defined globals and boot changes two of them, so this was the first time `bakeModule`'s globals rewrite ran on real values. `applyImage` copies memory only, and it now refuses an image that records changed globals or table slots unless the caller passes `memoryOnly: true`.

### Lifecycle and Initializers

The lifecycle study measured 45 Drupal executions from compile through first render on the M2 Pro:

|                       |     native | image in the module |       copied image |
| --------------------- | ---------: | ------------------: | -----------------: |
| Total elapsed, median |   830.5 ms |            444.7 ms |           460.6 ms |
| Process CPU, median   | 1,412.8 ms |            806.5 ms |           814.7 ms |
| Paired speedup        |            |  1.90x [1.82, 1.97] | 1.88x [1.79, 1.91] |
| Warm second render    |    66.0 ms |             62.9 ms |            64.3 ms |

Generating the image costs 10.4 s elapsed and 11.4 s CPU. Taking the difference of the medians, the image pays for itself after 27 boots in elapsed time and 19 in CPU, excluding shipping, storage and retention. That is a model, and fleet amortization was not measured.

The 21 fixed corpus initializers are small. Restoring an image after instantiation is 1.08x to 1.40x faster than conventional initialization, and a whole-memory application cache is slower on every kernel (0.52x to 0.94x). All 21 bake attempts refuse the module's start section, so a fresh instance followed by `applyImage` is the route measured.

### Delivery on the Edge

The Free plan account accepted the 13.4, 20.7 and 61.0 MB modules with a reported startup of 3 ms each. Instantiating in a Durable Object took 11 ms (unmodified), 16 ms (boot image) and 46 ms (after-render image) of cpuTime, so the extra cost follows the size of the delta. As active data segments, the after-render image exceeded the uncompressed upload limit, so it was delivered as static assets: 13 files of 4 MiB plus an index of page numbers and a 32-bit hash per page. The object reads the files from its `ASSETS` binding and writes them straight into the memory view, one 4 MiB buffer at a time. The bundle grew by 0.55 KiB and fetch, copy and instantiate cost 124 to 144 ms of cpuTime per cold object (hashing all 771 pages adds about 20 ms and found none wrong), against 46 ms for the data-segment module and 1.6 to 2.0 s for the host's rows route.

### Deployed Drupal Host

First request of a fresh site that matches the pack, n=5 per arm, alternating, fresh deploy, one normalized body hash and one CSRF token across arms, no memory reset:

| Run | Control cpuTime (ms) | Baked cpuTime (ms) | Saved | Control wall (ms) | Baked wall (ms) |
| --- | -------------------: | -----------------: | ----: | ----------------: | --------------: |
| 1   |                3,375 |                945 | 72.0% |             4,175 |           2,317 |
| 2   |                2,837 |              1,139 | 59.9% |             3,607 |           2,163 |

The baked arm was faster in 10 of 10 paired rounds. On PHP 8.5.12, on a second account, n=5 per arm, the first request took 3,709 ms of cpuTime plain and 1,039 ms baked with four chunk fetches in flight (72.0%, wall 4,283 and 1,855 ms).

The serve path is what a host does after an eviction: drop the interpreter, then render. PHP 8.5.12, host commit `f902595ccb`, Workers Paid account, n=4 per arm, alternating, medians of cpuTime with ranges in brackets:

| Step               |             Plain boot |          Baked image |                 Saved |
| ------------------ | ---------------------: | -------------------: | --------------------: |
| First request      | 3,822 [3,699 to 3,897] | 1,035 [815 to 1,078] |    72.9% (wall 52.4%) |
| Serve after drop   |     989 [970 to 1,092] |     555 [413 to 707] |     43.9% (wall 8.9%) |
| First `/bootphase` |   1,028 [906 to 1,334] | 1,016 [876 to 1,497] | 1.2% (wall 51% worse) |

The baked arm was cheaper in all 4 paired rounds of the serve step, and it moves 161 KB out through the SQL bridge against 1.196 MB for the plain boot. Four idle probes were real evictions: the plain boot's cold boot took 1,751 ms and 2,035 ms of cpuTime and the baked arm's 682 ms and 799 ms (n=2 per arm).

The `/bootphase` rows measure an instrument. It drops the interpreter and builds a second kernel from the database, ignoring the kernel the image carries, so the first `/bootphase` rebuilds caches that the image holds only in memory. Those rows do not describe the serving path.

### Stale State

The image holds the baking site's heap, and the first version served it to a site whose database had changed. After a rename, a cold boot from the image rendered the baking site's name while a plain boot of the same database rendered the new one. A second key, a digest of the 175 `config` rows read at boot (1 to 6 ms), sends such a site to the plain boot.

| Edit (table the render reads)             | Key that changed   | Cold boot         |
| ----------------------------------------- | ------------------ | ----------------- |
| site name (config)                        | config digest      | plain boot        |
| promoted node, block label (node, config) | config digest      | plain boot        |
| maintenance mode (key_value)              | none               | image, body equal |
| path alias (path_alias)                   | none               | image, body equal |
| module install (config, key_value)        | module fingerprint | plain boot        |
| theme color, visible (config)             | config digest      | plain boot        |

A site boots from the image only when its pack generation, module set, driver and config rows all equal the bake's. The configuration study ran 13 selected configurations in four arms: a strict configuration key admits 7 of 13, and a module key plus the consumer's configuration and entity reset admits 12 of 13. Enabling a module falls back to a fresh boot. All 39 safe-arm first responses match native status and normalized HTML, and the unguarded arm serves stale site-name and theme-color output. Those cases give no production eligibility rate.

### Secrets

An after-render image holds the heap of the process that produced it, including the site's private key, the configured hash salt and the state of the userland random generator. A safe image is built from a state that never held a real secret, and the real values are put in on replay. The real key and salt, a test user's name, mail and password hash and a planted session cookie are absent from the image and the baked module in raw, base64 and hex form, and a control bake that read real values contains all of them. After replay, a rekey step makes a CSRF token validate in a reference boot with the site's key and fail in one with the bake's, 9 of 9 and 0 of 9. The step costs 11.5 ms on 8.5.12 and 14.3 ms on 8.5.2. The bake request's PHP session identifier stays in the image, and the host must set a new one at the start of every request. The Drupal consumer does and tests it.

### Shrinking the Image

The delta image is 771 pages (50.5 MB). The allocator is dlmalloc, 32-bit, and 734 of the 771 pages are at least 90% live. Dropping pages that lie wholly inside free chunks removes 4 pages, 262,144 bytes, 0.52% of the image. A second search poisoned candidate pages and rendered eight steps: 98 pages (6.4 MB, 12.7%) did not change the output, which means only that those pages were not read on those paths. Neither drop changes the time: a cold first request is 1,286 ms plain against 310 to 340 ms for the full, the sound and the empirical image alike.

## Reading

An after-render image removes about 70% of the open-plus-first-render time locally and 60% to 73% of the first request's cpuTime for a fresh site on a Durable Object host. The image is a published file with a heap in it, so it needs throwaway secrets, a renewal step and a context key. The saving is limited to sites whose configuration equals the pack.

## Closed and Open

Closed: shrinking the image by dropping free pages (0.52%), and the `/bootphase` re-boot as a measure of the serving path.

Open: the share of real sites whose configuration equals the pack's, an eviction cost for a baked object beyond n=2 per arm, what spool serving adds to a page view, a per-site bake (it would cost a boot and 50 MB of assets per site), and any gain for a site whose configuration has changed. Menu links, user data, authenticated sessions, extension credentials, sockets, transactions and changed drivers were not tested. Only memory 0 of a module with several memories is written.

## See Also

- Report: [Baked Boot Images](../../TECHNICAL_REPORT.md#baked-boot-images), [Replay-Safety Contract](../../TECHNICAL_REPORT.md#replay-safety-contract)
- Module: [Boot](../modules/boot.md)
- Related study: [Memory Accounting](memory-accounting.md) for the memory cost of a larger image
