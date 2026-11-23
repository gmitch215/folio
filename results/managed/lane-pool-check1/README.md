# Lane Pool Check 1

## Question

Does a durable lane pool (`LanePool` and `serveLane` in `src/managed/`) turn 16 independent CPU units into wall-clock gain at k = 4 Durable Object lanes, and does its lease replay a lane that resets? The line was registered before the run in `experiments/lane-pool/README.md` as Version 1.

## Instrument

Client wall time of one request, taken by the driver (`experiments/lane-pool/run.ts`) against one deployed Worker with two Durable Object classes, on a Workers Paid account. The run deployed the Worker `cfw-folio-lanepool-36d115d0`, waited 90 s, ran the arms and deleted it. The CPU limit in the deployed config was 5000 ms and the lease 8000 ms. Run start: 2026-11-23T06:55:07Z.

## Design

- Serial arm: one Durable Object runs 16 units of 466 passes one after another.
- Pool arm: a coordinator object submits 16 tasks and four lane objects claim them one at a time.
- 1 warmup pair, then 10 timed pairs. The first arm alternates. Each pair uses a fresh coordinator name, so the serial arm computes on a fresh object and the pool arm on the same four lane objects.
- 3 burn runs (one task burns past the CPU limit on its first attempt) and 3 sleep runs (one lane sleeps 1.6 leases and renews nothing). Each run reads claims per task and accepted completions from the coordinator after the late lane had time to report.
- Calibration used `/serial` calls of 4 units on fresh objects, 5 per step, net of the median of 5 empty calls, scaled toward 100 ms a unit over at most three steps. The burn length came from the last measured unit.

Registered line, Version 1 (copied from the experiment README): a median gain of at least 1.2x over 10 pairs, outputs equal to serial in every pair and every fault run, and every injected reset replayed exactly once. Reject if any clause fails, including a fault that did not reset a lane.

## Results

Verdict: REJECT, as the run's decision rule returned. Five of the ten pairs have a serial arm that returned HTTP 500, so the gain figure in the rule's output is not a valid gain.

| Clause | Result |
| --- | --- |
| Gain of at least 1.2x, median of 10 pairs | rule output 4.27 over all 10 pairs; invalid, see below |
| Outputs equal to serial, 10 pairs | 5 of 10 unequal (pairs 1, 3, 4, 7, 9), all with a serial HTTP 500 |
| Outputs equal to serial, 6 fault runs | 6 of 6 equal |
| Burn reset a lane | 0 of 3 (no lane call rejected) |
| Burn replayed exactly once | 0 of 3 (the faulted task had 1 claim, not 2) |
| Sleep reset a lane | 3 of 3 |
| Sleep replayed exactly once | 3 of 3 (2 claims for the faulted task, 1 for the other 15, 16 accepted) |

Client wall in ms, from `raw-pairs.json`:

| Arm | Pairs | Walls | Median |
| --- | --- | --- | --- |
| Serial, HTTP 200 | 0, 2, 5, 6, 8 | 1063, 1094, 1104, 1125, 1365 | 1104 |
| Pool, same five pairs | 0, 2, 5, 6, 8 | 726, 732, 875, 1018, 1019 | 875 |
| Serial, HTTP 500 | 1, 3, 4, 7, 9 | 7480, 7509, 7572, 7681, 8192 | 7572 |
| Pool, all ten pairs | 0 to 9 | 699 to 1133 | 848 |

The ratio over the five valid pairs is 1.21 (1.08 to 1.86, median of the five). It is descriptive: it has 5 pairs, not the registered 10, and the registered rule did not compute it. The warmup pair ran serial 1493 ms and pool 1028 ms, both 200. The 500 bodies are an HTML error page titled "Worker threw exception". The run saved 500 characters of each body, which ends before the error code.

Calibration, client wall in ms of a 4-unit serial call on a fresh object, five calls per step (`raw-calibration.json`, `raw-requests.jsonl`):

| Passes | Walls | Median | Unit net of the 244 ms empty call |
| --- | --- | --- | --- |
| 650 | 1002, 921, 921, 3175, 1054 | 1002 | 189.6 ms |
| 343 | 2529, 513, 1945, 281, 538 | 538 | 73.6 ms |
| 466 | 819, 2149, 729, 3669, 2257 | 2149 | 476.3 ms |

The loop ended after the third step. It used 466 passes and took 1.02 ms a pass, from the last step, to size the burn at 14,676 passes. The empty calls ranged from 198 to 272 ms.

Burn runs: wall 1945, 1963 and 1944 ms against a pool median of 848 ms for a run without a burn, all HTTP 200, `laneErrors` 0, 16 done, every task one claim.

Resources: the account had 21 scripts and 93 Durable Object namespaces before the run and 20 and 92 after. The run's own Worker was absent after teardown (0 leftovers). The difference came from changes outside the run. The inventory snapshots hold other Workers' names and are not exported. The driver made 55 Worker requests against a plan of 43 and a cap of 86. The plan priced the run at most $0.0078 at list rates; billing was not read back.

## Reading

The registered line rejects, and the rejection stands for Version 1. It holds for two independent reasons: the serial arm failed in half the pairs, and the burn did not reset a lane in any run.

The records show these things:

- The cost of a unit on a fresh object was bimodal. In calibration, 9 of 15 calls took 0.03 to 0.31 ms a pass (eight of them 0.20 to 0.31) and 6 took 1.0 to 1.8 ms. In the timed serial arm, 5 pairs finished in 1.06 to 1.37 s and 5 failed after 7.5 to 8.2 s. The pool arm was never slow in 11 pairs. The order of the arms in a pair does not separate the two modes.
- The 500s fit the 5 s CPU limit. At the slow pace, 16 units of 466 passes need more than 5 s of CPU. The records do not prove it, because the body was cut before the error code.
- The burn never exceeded the limit. It ran 14,676 passes inside a call of at most 1.95 s, so at most 0.13 ms a pass and at most 1.95 s of CPU against a 5 s limit. The 1.02 ms a pass that sized it came from a slow draw.
- Calibration did not converge: three steps gave 189.6, 73.6 and 476.3 ms against a 100 ms target, and the run went on.

The cause of the slow mode is not identified. The records are consistent with a per-object effect on fresh objects, since the four reused lane objects were never slow, but they do not test it. This study does not support a statement about the pool's gain either way. Version 2 of the experiment changes the calibration, the unit size, the burn sizing and the handling of failed calls, and has not run.

## Limits

- One account, one coordinator location, one run, one day.
- The 500 body was cut at 500 characters. The cause of the 500s is inferred from walls and calibration.
- The five valid pairs are a subset chosen by the serial arm's success, so the 1.21 is not an estimate of the pool's gain.
- The cause of the two speed modes is open. The serial arm used fresh objects and the pool arm reused lane objects, and the run does not separate that from other causes.
- Wall time was measured at the client, and CPU time was not read back.
- Resource counts before and after differ by one script and one namespace that this run did not create. Only the counts are recorded.
- The sleep arm replayed exactly once in 3 of 3 runs. That is a result of 3 runs.

## Artifacts

- `raw-requests.jsonl`: every request of the run, with status and wall. The workers.dev host in the 500 body text is replaced by `<worker host>`.
- `raw-pairs.json`, `raw-faults.json`, `raw-calibration.json`: the timed pairs, the six fault runs and the calibration.
- `summary.json`: the run's own summary. The hash references of the two changed resources outside the run are removed.
- `run.json`: the run record and its priced plan. `run.log`: the driver's stage log.

Source digests (SHA-256) of the code that ran, identical on the laptop and the rig. The files were untracked or modified at repository commit `377905d085db757a91b31b2f334ccad928c50382`, so these pin the code:

```text
2d204818f10075a725b60b36dcf4730ef2a1f0720d25d0d4f9c349582585b481  experiments/lane-pool/README.md
25289351288e77575fed20376d18c01ed4ea4f68563c5647a59dad9936745e80  experiments/lane-pool/local.ts
13f76478b56c06fec5a7c14e1f0700c7d74cd3e6cd5be087dff50a9e1f98576d  experiments/lane-pool/plan.ts
5ef40ed1368ce9f3a3836d222941e758a6b385ff30146364e733d66934ab4959  experiments/lane-pool/run.ts
65981291fde20f7ce4232a8156ffd0b6f6d3fb5e417068f1a7094386108d56c0  experiments/lane-pool/task.ts
fe70a51948249efe92ae6d4f12c9fdd2ce354322675967729f89ce9d033a77a3  experiments/lane-pool/tsconfig.json
3d7a9f88fe146d6543dd6ac4bd51a952ae89d8690a2a6a0f800f5c1445022f02  experiments/lane-pool/worker.ts
71b9b2b99ba32ff90b8481ae3e24c55e8ea97e2094b2365df1571aea31c45980  experiments/lane-pool/workerd.d.ts
ec63984925d891102d6172e0e8bf247cab6a5ca572801b5b5fa742443eff1170  experiments/lane-pool/wrangler.jsonc
01d1f35683fb3dfd33f77e1ff845b1bb85683b499d5233b1f8eb386304dbc4c1  src/managed/tasks.ts
13a30704df373a93bdd20cc2ca2a128602d28f5a2f7506b3ca31745987bed663  src/managed/pool.ts
```

The experiment files in the working tree have since changed for Version 2, so they no longer match these digests.

## Reproduce

The Version 1 code is not in the tree any more, so a rerun means Version 2. To check the figures above from the exported records, from the repository root:

```sh
node -e '
const pairs = JSON.parse(require("fs").readFileSync("results/managed/lane-pool-check1/raw-pairs.json"));
const valid = pairs.filter((p) => p.serialMs < 5000);
const ratios = valid.map((p) => p.serialMs / p.poolMs).sort((a, b) => a - b);
console.log({ valid: valid.map((p) => p.pair), median: ratios[ratios.length >> 1] });
'
node scripts/research/evidence.ts
```

A new deployed run needs the Paid account pair in `FOLIO_CLOUDFLARE_ACCOUNT_ID` and `FOLIO_CLOUDFLARE_API_TOKEN` and follows `experiments/lane-pool/README.md`.
