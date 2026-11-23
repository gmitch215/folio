# Lane Pool Check 2

## Question

Does the lane pool turn 16 independent CPU units into wall-clock gain at k = 4 Durable Object lanes, and does its lease replay a lane that resets, under the Version 2 line registered after [lane-pool-check1](../lane-pool-check1/README.md)? The line is in `experiments/lane-pool/README.md`.

## Instrument

Client wall time of one request, taken by the driver (`experiments/lane-pool/run.ts`) against one deployed Worker with two Durable Object classes, on a Workers Paid account. The run deployed the Worker `cfw-folio-lanepool-546bfbba`, waited 90 s and ran calibration. CPU limit in the deployed config 5000 ms, lease 8000 ms. Run start: 2026-11-23T07:14:43Z. A second session ran it on the rig host from the Version 2 code.

## Design

Version 2 calibration, before any timed pair: 5 empty calls, 2 discarded warmups of the timed serial shape (a fresh object, 16 units), then 3 measured calls per pass count starting at 650 passes. The run stops with a named reason if a call fails, if the 3 calls differ by more than 25 percent, or if 190 ms a unit is not reached in 6 pass counts. The timed phase is 1 warmup pair and 10 timed pairs, then 3 burn runs and 3 sleep runs. Registered line: a median gain of at least 1.2x over the valid pairs (a pair is valid when both arms return 200), outputs equal to serial in every valid pair and fault run, every injected reset replayed exactly once, fewer than 10 valid pairs rejects.

## Results

Verdict: stopped at calibration. 0 timed pairs ran, 0 fault runs ran, and every clause of the line is unevaluated. The run's own summary reads `verdict: stopped` with the reason "a calibration call returned HTTP 500 at 650 passes".

| Call                | Status | Wall (ms)            |
| ------------------- | ------ | -------------------- |
| ready               | 200    | 307                  |
| empty 1 to 5        | 200    | 158, 203, 208, 227, 237 |
| warmup 1 (16 units) | 200    | 1461                 |
| warmup 2 (16 units) | 500    | 7384                 |
| measured at 650     | 500    | 7353                 |

The empty-call median was 208.2 ms. Warmup 1 is about 78 ms a unit net of it (16 units of 650 passes, about 0.12 ms a pass). Warmup 2 and the measurement are the same call shape, on fresh objects, and both returned HTTP 500 after about 7.4 s. The calibration record holds one row, the failed measurement.

Both 500 bodies are 4605 characters, saved in full (`truncated: false`). Each is the HTML error page titled "Worker threw exception" with the code `cf-error-code` 1101. Run 1 saved only 500 characters, which ended before the code.

Resources: the account had 18 scripts and 47 Durable Object namespaces before the run and the same after, with the same digest. The run's own Worker was absent after teardown. The driver made 9 Worker requests against 63 planned. The plan priced a full run at most $0.0149 at list rates (63 Worker requests, 765 Durable Object requests, 875.5 GB-s assumed); billing was not read back, and this run stopped far short of the plan.

## Reading

The run answers none of the three clauses. It does show that the slow call of run 1 was not a one-off: within one run the same 16-unit call took about 1.5 s once and failed after 7.4 s twice, on fresh objects, with no change in the call.

The error page carries code 1101, an uncaught exception in the Worker. Run 1's reading was that the 500 is the 5 s CPU limit. These records do not settle it. The other session's reading is that the Durable Object call was rejected and the Worker did not catch the rejection, which produces a 1101 page. That is an inference: the page does not name the exception, and the Worker in this run had no catch that would have logged it. The walls of 7.4 s fit a call killed at the CPU limit and are not proof of it.

The cause of the two speeds is open.

## Limits

- One run, 9 requests. Calibration saw 1 success and 2 failures of the timed shape.
- The two failed calls give no error text beyond the page. The Worker did not catch the rejected object call.
- Wall time was measured at the client. CPU time and billing were not read back.
- The line is unchanged by this run. A stop at calibration is a valid outcome of Version 2 and not a rejection of the gain.

## Artifacts

- `raw-requests.jsonl`: all 9 requests with status and wall; the two failures carry the full body and the headers. The workers.dev host in the bodies is replaced by `<worker host>`.
- `raw-calibration.json`: the calibration record, one row and the stop. `summary.json`, `run.json` and `run.log`: the run's own summary, plan and stage log.

Source digests (SHA-256) of the code that ran, identical on the laptop and the rig host, at repository commit `377905d085db757a91b31b2f334ccad928c50382` with the experiment and managed files untracked or modified:

```text
f1b8add59a71b333c1e8dc381bc167f81ea9fd2f26aeadc0edd7182783b09a07  experiments/lane-pool/README.md
25289351288e77575fed20376d18c01ed4ea4f68563c5647a59dad9936745e80  experiments/lane-pool/local.ts
4ae7fa94e7fb36f8e0ca71529dffd3bce7b4da794fd025d3aeabcaf12519b099  experiments/lane-pool/plan.ts
84ae63888d3c6457e2ee2859277e1944620afeb55892fd5b8aa9b32784633a24  experiments/lane-pool/run.ts
65981291fde20f7ce4232a8156ffd0b6f6d3fb5e417068f1a7094386108d56c0  experiments/lane-pool/task.ts
fe70a51948249efe92ae6d4f12c9fdd2ce354322675967729f89ce9d033a77a3  experiments/lane-pool/tsconfig.json
9ce492a29b5e223f306fb2be19b2ce865948aaf1a4d77d477fe52d1a7be95716  experiments/lane-pool/worker.ts
71b9b2b99ba32ff90b8481ae3e24c55e8ea97e2094b2365df1571aea31c45980  experiments/lane-pool/workerd.d.ts
ec63984925d891102d6172e0e8bf247cab6a5ca572801b5b5fa742443eff1170  experiments/lane-pool/wrangler.jsonc
13a30704df373a93bdd20cc2ca2a128602d28f5a2f7506b3ca31745987bed663  src/managed/pool.ts
01d1f35683fb3dfd33f77e1ff845b1bb85683b499d5233b1f8eb386304dbc4c1  src/managed/tasks.ts
```

## Reproduce

To check the figures from the exported records, from the repository root:

```sh
node -e '
const rows = require("fs").readFileSync("results/managed/lane-pool-check2/raw-requests.jsonl", "utf8").trim().split("\n").map(JSON.parse);
console.log(rows.map((r) => [r.status, Math.round(r.wallMs)]));
'
node scripts/research/evidence.ts
```

A new deployed run needs the Paid account pair in `FOLIO_CLOUDFLARE_ACCOUNT_ID` and `FOLIO_CLOUDFLARE_API_TOKEN` and follows `experiments/lane-pool/README.md`.
