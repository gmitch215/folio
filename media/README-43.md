# PHP Poll Cost

What does the poll in the PHP interpreter cost when no park happens? The control is the same build with the poll body reduced to a no-op.

## Instrument

Three CPU workloads (a loop of 60 million iterations, `fib(35)`, and 6,000 string-array passes) on a Linux x86-64 machine. Two builds: the park build with its poll (labelled `I5` in `raw.jsonl`) and a no-op-poll build (`NOOP`) that differs only in the poll macro. Eleven rounds with the two builds in rotated order; each sample boots a fresh instance and times only the PHP run.

## Rows

`raw.jsonl` holds one row per sample with its workload, round, build, time, poll and refusal counts, and the output hash. The source is the tab-separated files written by the measurement harness; `experiments/continuation/export.ts` takes their directory as an argument.

## Reproduce

```sh
node experiments/continuation/export.ts <directory with loop.tsv, fib.tsv and strarr.tsv>
node scripts/analyze/continuation.ts
node scripts/research/evidence.ts
```

## Scope

One machine, one run, no repeats beyond the eleven rounds. The poll cost is the paired ratio of the two builds, not a per-poll count. The no-op build removes the call but keeps the rest of the patch, so the figure is the poll's cost and not the patch's.
