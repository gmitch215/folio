# Focused Repeat

Question: is the spread in the eight-worker speedup (AES-CBC decrypt reads 7.42x in one run and 4.80x
in a repeat) caused by the idle worker pools that the [reset-policy harness](../reset-policies/README.md)
keeps open, or does it have another source?

The reset-policy harness opens an ordinary and a `TaskPool` pool at widths 1, 2, 4 and 8 and rotates
through all of them, so 30 worker threads exist while any one arm is timed. This study times one
active pool at a time, with the serial run paired in the same round, and runs the idle pools only as
a separate condition.

## Method

Four kernels (AES-CBC decrypt, SHA-256, LZ4 compress and xxHash32, the shortest), three reset
policies, ordinary workers and `TaskPool`, 16 jobs of 4 operations per sample. Each cell runs 2
warmup and 9 measured pairs, and each pair runs the serial control and the pool back to back,
alternating which goes first. Arms per kernel and policy: width 8 alone, width 8 with the 22 idle
worker threads of every other pool open (the original condition), and width 1 alone. The arm order
is shuffled from the session label. Five independent sessions, each a new process, ran on the
Ryzen machine under `nice -n 19` on cores 4 to 11. Every sample compares every return and the
final context state with the serial result, and records the load average and the frequency of each
allowed CPU before the timed run. The governor was `powersave`.

## Results

Paired median speedup over the serial control, per session.

- **Idle pools are not the cause.** For the 24 pairs of a width-8 cell with and without the idle
  pools, the idle-to-clean ratio of the five-session median is 0.945 to 1.253. 19 pairs are within
  5% and 23 within 10%. The largest, xxHash32 under learned pages with ordinary workers (1.25), is
  also the cell with the widest spread.
- **The spread persists with a clean pool.** AES-CBC decrypt under learned pages reads 4.07x to
  5.34x with ordinary workers and 4.00x to 4.69x with `TaskPool` across the five sessions, and the
  five-session medians are 4.67x and 4.59x. Under the whole-arena reset it reads 2.73x to 3.05x, and
  under the checkpoint 3.68x to 4.51x. The 7.4x reading appears once in these 20 learned-page
  readings of that kernel (7.23x, ordinary workers with idle pools, one session) and never in a clean
  cell.
- **The serial control and the one-worker arms are stable for long kernels.** Serial wall time is
  68.8 to 71.5 ms for AES decrypt in the learned-page cells. One-worker arms read 0.97x to 1.01x for
  AES and SHA-256, and are noisy for the two shortest kernels (0.64x to 1.17x for LZ4 and xxHash32 under
  learned pages).
- **The variation is in the eight-worker arm and is wider under learned pages.** The ratio of the
  largest to the smallest session median for a width-8 cell is 1.12 to 2.04 under learned pages,
  1.06 to 1.56 under the whole-arena reset and 1.05 to 1.31 under the checkpoint. The eight
  cells above 1.5 are all learned-page or short-kernel cells.
- **Ordinary workers and `TaskPool` agree.** The five-session median of `TaskPool` over ordinary
  workers is 0.89 to 1.14 across the 12 kernel and policy pairs, with no consistent sign, so the
  spread is not specific to the pool type.
- **The CPU frequency before a run explains part of it.** The Spearman correlation between the
  median frequency read before a width-8 run and its wall time is negative in 9 of 12 kernel and
  policy groups, down to -0.48 (SHA-256 under the checkpoint), and near zero for AES decrypt under
  learned pages (-0.06). The governor was `powersave`, and the median allowed CPU read below 1 GHz
  before 51% of the pool samples, so a 10 to 18 ms burst can start before the clock has ramped. The
  load average of the box was about 1.2 to 3.6 during these sessions, from other work that the pinning does not exclude.

Reading: the 4.8x to 7.4x spread is not caused by the idle pools, and no pool type or reset policy
reproduces the 7.4x. The evidence fits run-to-run variation of short eight-thread bursts on a shared
box, with a measured but partial frequency effect. It does not show a defect in the eight-worker
implementation, and it does not rule one out for the learned-page policy, whose spread is the widest.
Quote the eight-worker AES decrypt speedup as 4x to 5x for learned pages on this machine, with
occasional readings near 7x.

Five sessions on one machine are a small sample, and the frequency readings come before the run and
not during it.

## Reproduction

```sh
node scripts/research/focused.ts build/research/focused-session-1 9
node scripts/research/analyze.ts build/research/focused-session-1/raw.jsonl summary.json
node scripts/research/derive.ts session-spread spread.json session-*.summary.json
```

`scripts/research/focused.sh SESSIONS PAIRS` runs the sessions under the timing lock with `nice -n 19`
and cores 4 to 11.

## Artifacts

- `session-1.jsonl` to `session-5.jsonl`: raw records, 1,296 samples each.
- `session-N.summary.json`: paired summaries, one per session.
- `spread.json`: per-cell medians across sessions and the idle-pool ratios.
- `before.log`: memory, disk, load and governor at the start.
- `source.tar.gz`: the source the sessions used.
- `manifest.json`: byte lengths and SHA256 digests.
