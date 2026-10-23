# Managed Chromium Sharing Probe

The deployable experiment launches Cloudflare Browser Run from an authenticated
Worker and navigates to the same Worker's page. Chromium Web Workers execute
the existing C fixtures against one shared Wasm arena. The Worker/DO heaps do
not receive that arena. A successful deployment establishes a different managed
execution location for physical sharing.

## Controls

The page and both scripts carry COOP `same-origin`, COEP `require-corp` and CORP
`same-origin`. The page verifies `crossOriginIsolated` before allocating anything.
Eight dedicated workers receive one `WebAssembly.Memory` with a 256 MiB initial
size and 512 MiB maximum, plus precompiled module objects. The parent touches
every 4 KiB page; each worker reads the same resident pages. This creates one
arena, without one full arena copy per worker.

Four workers run the C atomic add 10,000 times each and write disjoint ordinary
words. Parent-to-worker, worker-to-parent and worker-to-worker reads must match.
A separate ordinary 64 KiB `ArrayBuffer` clone must retain independent values in
all four recipients and the parent. Shared growth adds one 64 KiB page; every
participating worker checks all new bytes before any writes to that page, and
then fresh views observe cross-worker writes. Old views retain their old length.

A final creator worker returns a shared memory and receives `terminate()`.
Another worker attaches and mutates the surviving memory. Browser termination
has no join acknowledgement; the record says `terminationRequested`, rather than
claiming an observed operating-system thread exit.

These controls establish shared native memory semantics. The
[HTML structured cloning algorithm](https://html.spec.whatwg.org/multipage/structured-data.html#structuredserializeinternal)
retains the same shared data block for a SAB and copies ordinary ArrayBuffer
bytes. Wrapper equality, memory sizes and RSS alone would not establish that.
The experiment does not expose Chromium's native backing-store addresses or
physical frame numbers.

## CPU Samples

The existing C `program` export runs the same 64 independent xorshift word
kernels at widths 1, 2, 4 and 8, alongside the page's native owner baseline.
Calibration selects one fixed round count for all arms (65,536 to 2,097,152,
stopping when the owner takes at least 80 ms). Every arm receives one warmup
and three retained measured executions, with rotated arm order. Timings include
worker messaging; validation compares all 64 output words outside the interval.
The rest of the 256 MiB arena is the sharing/residency control, not the CPU
kernel's working set. This probe uses explicit ranges; it does not exercise
Folio's automatic extraction or prove a full PHP consumer.

`performance.now()` measures wall time in Chromium. Per-lane durations remain
wall time. No process CPU accounting is available through this harness, so it
does not report aggregate CPU work or prove a number of physical cores from a
timing ratio alone. JSPI is recorded as API presence, not a suspension test.

## Session Budget And Authentication

`PROBE_TOKEN` must be a deployed secret. Only `POST /run` with its bearer token
can access the browser binding. A named singleton `BrowserGate` Durable Object
permits one running request and at most two attempts in its lifetime, including
failed launches. The session deadline is 85 seconds; the browser closes in
`finally`, including late launch completion. Client commands have 12-second
timeouts and the page's own work budget is 65 seconds. Every worker terminates
in `finally`. Total planned use is at most two sessions and 170 session seconds;
successful local executions took under two seconds of page work.

Current primary documentation, read 2026-10-20:

- [Browser Run Playwright](https://developers.cloudflare.com/browser-run/playwright/)
  documents `launch(env.BROWSER)`, `browser.close()`, the `browser` binding,
  `nodejs_compat`, and compatibility date 2025-09-15 or later for the current SDK.
- [Browser Run limits](https://developers.cloudflare.com/browser-run/limits/)
  lists Free allowances of 10 browser minutes per day, three concurrent browser
  sessions, and one new browser every 20 seconds. Its 60-second timeout is an
  inactivity timeout; the probe sets a separate total deadline.
- [Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/)
  confirms availability on Free. This experiment changes no account plan.
- The installed official package is `@cloudflare/playwright` 1.3.6, pinned in
  this directory's private package/lockfile. Its
  [upstream repository](https://github.com/cloudflare/playwright) is the Workers
  fork, rather than upstream Node Playwright running inside a Worker.

## Reproduction

From the Folio root, with an account selected through `FOLIO_CLOUDFLARE_ACCOUNT_ID` and
`FOLIO_CLOUDFLARE_API_TOKEN` (or the `FREE_CLOUDFLARE_*` pair):

```sh
bun install
bun run build:c
node experiments/browser/prepare.ts
bun run test
node experiments/deploy.ts browser
node experiments/browser/analyze.ts experiments/browser/runs/NAME/result.json
```

`prepare.ts` transpiles `probe.ts` to `build/probe.js`, the text the Worker serves to Chromium.
`deploy.ts` deploys with the repository's Wrangler, sets `PROBE_TOKEN`, sends the secret in the
authorization header and saves the entire response JSON, so no shell tracing, URL tokens or
persisted request headers are involved. `analyze.ts` checks that response. Wait at least 20
seconds between a failed launch and the second
attempt. Before launching, inspect current account sessions/remaining allowance
through the Browser Run dashboard. The documented `env.BROWSER.limits()`,
`listSessions()` and `history()` methods expose admission/concurrency and recent
session durations. The installed SDK exports `limits(env.BROWSER)`,
`sessions(env.BROWSER)` and `history(env.BROWSER)` for these operations. Its
limits response has no remaining-daily-minutes field; do not derive unused daily
allowance from an empty active-session list.

Deleting the Worker also requires the deployment driver to remove the
`BrowserGate` class with a migration and verify that its namespace is gone.
No account resources were created by this directory's local preparation.

Local-only validation needs `playwright-core` and a downloaded Chromium, neither of which is a
repository dependency:

```sh
node experiments/browser/local.ts
```

`results-local.json` retains every local sample and is explicitly labelled
`local-chromium-only`. Its successful controls validate this harness before
deployment; they are not evidence from Cloudflare's managed Chromium.

## Preparation Results

Four hermetic tests pass: native lane protocol and copying, standalone asset
source, launch authentication/headers, and the singleton's concurrent/total
session bounds. Wrangler 4.139.0 dry-run resolves the Browser Run and DO
bindings and bundles the official SDK with both C fixtures. The pre-format
bundle was 3098.53 KiB, 628.17 KiB gzipped; this is a deployment-size check,
not a managed run.

The retained local result used HeadlessChrome 153.0.8010.12 and reported eight
distinct agents, one 268,435,456-byte arena, JSPI API presence, all alias/copy/
growth/lifetime controls passing, and 20 exact CPU-arm executions. Page work
took 1763.790 ms. Three measured samples per width remain in the JSON, together
with every warmup and calibration sample. The local median times for owner/
1/2/4/8 workers were 118.160/117.500/60.765/30.965/15.820 ms. These numbers only
validate the harness and are not Cloudflare performance evidence.

Managed results are collected by the deployment driver. A
failed browser binding or API call must retain its HTTP status and error before
trying the separately documented CDP route; it does not refute shared memory
inside Chromium.

Deployed evidence is retained in
`runs/cfw-folio-browser-0e66d825/`: the shared 256 MiB arena and all controls
pass across eight browser workers. Four-worker elapsed median is 30.785 ms
against 119.250 ms at the owner (3.874x); all three observations per width
remain in the raw result. This browser reports four hardware-concurrency slots
and no JSPI API. Session wall time is 5257 ms. The account baseline is restored.
