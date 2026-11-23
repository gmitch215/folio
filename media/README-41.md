# Signal

Does a Durable Object alarm event receive the CPU warning from the platform, and does a Wasm guest that stops on it avoid a CPU reset?

## Instrument

A deployed Durable Object (`experiments/continuation/signal`) runs a 64-bit LCG kernel, `burn.wat`, that polls the signal word at 1024. Calibration calls burn a fixed number of blocks per request. The signal calls burn 102,680 blocks in up to three events per object and report the word before and after each event. The sync chain (`/chain?mode=sync`) carries state in storage across alarm slices.

Platform: a Durable Object in one account, one isolate per object until the platform moves it. Figures are CPU and wall times from `wrangler tail` joined to the Durable Object's own responses.

## Rows

`raw.jsonl` holds one row per call (`calibration`, `signal`), one row per chain (`sync-chain`) and one row per slice (`sync-slice`). Object ids are replaced by ordinals. The `prose` row records a probe that was reported in text only.

## Reproduce

```sh
node experiments/continuation/build.ts
node experiments/continuation/signal/run.ts a1     # deployed arms need account variables, see experiments/continuation/README.md
node experiments/continuation/export.ts
node scripts/analyze/continuation.ts
node scripts/research/evidence.ts
```

## Scope

One account, one deployment, runs in November 2026. A reset in the first event of an object came from a pending write held across a long synchronous stretch; the probe does not separate that cause from the signal. The signal's timing is platform policy and may change.

`finalMatch` is false for all 3 sync chains. This probe carried only a block count across events, not the guest's state (worker.mjs), so its final value is not expected to match after a reset. The study tests signal stops and completion, not state continuity; the durable-chain and boundary-commit studies test continuity. The value is in `syncChains.finalMatchNote` in `summary.json`.
