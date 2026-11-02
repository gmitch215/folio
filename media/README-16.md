# Reset Policies

Question: for explicit independent operations on private contexts, what does the reset between
operations cost, and what does a generalized reset give up against one tuned to a fixed input?

Three policies restore the 8 MiB arena of each context between operations:

- `whole` copies the whole arena.
- `pages` copies the pages that the first execution of a fixed input changed. It is valid only for
  unchanged code, input and host state.
- `checkpoint` compares every page of current memory with the initial copy and rewrites the pages
  that differ, so it learns nothing from an earlier run. Globals and table references are restored
  too.

All three runs use the same 21 kernels, arms and parameters in one session per machine: 7 paired
rounds, 4 repeats, 16 jobs per round, native, conventional workers and `TaskPool` at widths 1, 2, 4
and 8, each batched and unbatched. Every sample checks the final context state and every return
value. These are explicit independent operations, not automatic extraction.

## Results

Paired median speedup over native for eight batched `TaskPool` workers, with process CPU as a ratio
of native CPU. The full set is in the summaries.

| Kernel | Machine | `whole` | `pages` | `checkpoint` |
| --- | --- | ---: | ---: | ---: |
| AES-CBC decrypt | Ryzen | 3.19x / 1.97 | 4.80x / 1.05 | 4.52x / 1.30 |
| SHA-256 | Ryzen | 0.92x / 5.93 | 3.79x / 1.10 | 2.52x / 2.35 |
| LZ4 compress | Ryzen | 0.44x / 12.67 | 3.11x / 1.52 | 1.14x / 4.59 |
| xxHash32 | Ryzen | 0.43x / 12.62 | 2.48x / 1.80 | 1.40x / 3.93 |
| AES-CBC decrypt | M2 Pro | 5.22x / 1.30 | 4.85x / 1.12 | 5.21x / 1.40 |
| SHA-256 | M2 Pro | 3.69x / 1.66 | 5.15x / 1.11 | 3.93x / 1.81 |
| LZ4 compress | M2 Pro | 2.06x / 2.80 | 3.07x / 1.64 | 2.27x / 3.05 |
| xxHash32 | M2 Pro | 1.69x / 4.21 | 2.27x / 1.99 | 2.20x / 3.05 |

On the Ryzen machine `pages` is ahead of `checkpoint` and `checkpoint` is ahead of `whole` for all
21 kernels. The checkpoint recovers most of the gain for large kernels and little for small ones,
because it reads every page on every restore. On the M2 Pro the gaps are smaller and the ordering
is not consistent: `whole` and `checkpoint` match `pages` for AES-CBC decrypt (5.22x and 5.21x
against 4.85x), and `pages` leads on most other kernels.

The earlier [changed-page study](../page-reset/README.md) reports 7.42x for AES-CBC decrypt with the
`pages` policy under the same parameters on the same machine. This run reports 4.80x. Native
(69.9 ms against 69.5 ms) and one-worker arms agree within 1% between the two runs. The eight-worker
arm does not (9.44 ms against 14.55 ms), and the box load average was 0.1 at the start of the first
run and 1.41 at the start of this one. The eight-worker figure for this kernel is a range from 4.8x
to 7.4x on this machine, not a point value.

## Reproduction

From the repository root with Node 26 and the built corpus (`node scripts/research/corpus.ts build
build/research/corpus/build.jsonl`):

```sh
FOLIO_CORPUS_RESET=checkpoint node scripts/research/corpus-mechanisms.ts build/research/reset-checkpoint 7 4
node scripts/research/analyze.ts build/research/reset-checkpoint/raw.jsonl summary.json
```

Use `whole` and `pages` for the other policies and a new output path for each run.
`scripts/research/matched.sh` runs the three policies back to back under a shared timing lock with
`nice -n 19`, `--max-old-space-size=128` and, on Linux, `taskset -c 4-11`. The Ryzen records come
from that script on Linux with Node 26.10.0, cores 4 to 11 and the `powersave` governor. The M2 Pro
records ran on macOS with Node 26.8.2 and no pinning.

## Artifacts

- `ryzen-whole.jsonl`, `ryzen-pages.jsonl`, `ryzen-checkpoint.jsonl`: raw records, 2,499 samples
  each.
- `m2-whole.jsonl`, `m2-pages.jsonl`, `m2-checkpoint.jsonl`: the same on the second machine.
- `*.summary.json`: paired summaries generated from the matching raw file with `analyze.ts`.
- `source.tar.gz`: the source the Ryzen runs used. The M2 Pro records name their sources by SHA256
  in the environment row; the corpus harness and `src/` match the archive byte for byte.
- `manifest.json`: byte lengths and SHA256 digests.

Intervals in the summaries are bootstrap intervals over paired rounds within one run. They do not
cover run-to-run variation, which the eight-worker arm shows is large.
