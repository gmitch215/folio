# Checkpoint Cost

What do the hash pass, the page-hash checkpoint and the restore cost on a local Node 26 runtime, and is an interrupted run exact?

## Instrument

`experiments/continuation/local` (Node 26, JSPI, `node:sqlite`, Apple M2 Pro). The guest raises the signal every K steps from inside Wasm, because a synchronous guest cannot be interrupted from JavaScript. Run 1 checks exactness and the per-event handoff. Run 2 runs a durable chain with checkpoints every tenth yield, kills at three yields, restores, and corrupts one byte to test refusal. Run 3 times the hash pass and the checkpoint at 32, 64 and 128 MiB with 0 to 64 MiB changed. Run 4 measures the poll tax on one kernel.

The host ran other work during the runs. Timing spreads are wide.

## Rows

`raw.jsonl` holds the summary of each run, one `timing` row per handoff measurement, one `checkpoints` row per checkpoint in run 2, `hash-pass` and `checkpoint` rows for run 3, and one `poll-pair` row per pair in run 4. `raw-hashpages.jsonl` holds one `hash-bench` row per run (see Hash rate).

## Reproduce

```sh
PATH=/opt/homebrew/opt/node/bin:$PATH node experiments/continuation/local/run.mjs
node experiments/continuation/export.ts
node scripts/analyze/continuation.ts
node scripts/research/evidence.ts
```

Run 3 takes about 10 seconds. The whole script takes several minutes.

`export.ts` rebuilds `raw-hashpages.jsonl` from the recorded I9 samples in `experiments/continuation/local/runs/hashpages-i9.json`. Running `node scripts/probe/hashpages-bench.ts` measures again and prints new `hash-bench` rows on stdout. Those rows are new samples, not the recorded ones, so the bench output does not replace `raw-hashpages.jsonl`.

## Scope

Local Node timing, not workerd and not a Durable Object. Run 4 does not resolve the poll tax at seven pairs. The guest in this study is not the PHP guest.

## Event cost

`eventCost` costs one commit per event: the 16 MiB checkpoint from `durable-chain` (78 ms median) plus a handoff of 51 to 71 ms. The handoff is recorded in the experiment notes, not in a raw file, so it is a labelled input. The move-rate input is the lower bound on mean CPU between moves from `deferred-chain`, 261 s.

The loss term is S / M_f, with S the signal-first event CPU (32.475 CPU-s median). A move after a deferred event loses the whole slice, so each move costs one event's CPU. A signal stop comes every 18.0 events under AIMD (ratio 0.7, growth 2%), and the text's 13 to 18 range is shown as well. Deferred-only, with every event ending on the signal, pays the loss term at every move.

With these inputs AIMD costs 1.09 to 1.15% per event over a full cycle, or 1.35 to 1.42% at 13 events. Deferred-only costs 12.83 to 12.89%: the loss term is 12.43% (S / M_f) and the commit 0.40 to 0.46%. These do not reproduce the 0.93% and 2.95% in the text. The gap is the move-rate input: this study supports a mean CPU between moves of at least 261 s, not 681 s.

## Hash rate

`raw-hashpages.jsonl` holds the I9 hash-rate samples: five paired runs at 32 MiB and five at 128 MiB, on Node 26.8.2 on one machine. Each run times `hashPages` and then SHA-256 (`crypto.subtle.digest`) on the same buffer, so the ratio is taken within a run. The host ran other work during the runs.

The median `hashPages` rate is 1.258 GiB/s at 32 MiB (range 1.225 to 1.292) and 1.009 GiB/s at 128 MiB (range 0.253 to 1.320). The SHA-256 medians are 2.047 and 2.077 GiB/s, and the paired ratio medians are 0.63 and 0.49. The 128 MiB runs are split: three at 1.01 to 1.32 GiB/s and two near 0.25 GiB/s. The cause is not measured.

The rerun is not recorded here. One run of `scripts/probe/hashpages-bench.ts` on the same Mac, made while adding the script, gave `hashPages` medians of 1.222 GiB/s at 32 MiB (two of five runs near 0.26) and 1.323 GiB/s at 128 MiB. The spread between runs is wide, so treat any single median from this study as a range.
