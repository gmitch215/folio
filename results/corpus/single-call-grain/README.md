# Single-Call Grain

Question: can one 64 KiB call of AES-CBC decrypt be split across eight workers once the memory-carried
chaining value is removed, and what does the private context cost?

The corpus kernel `aes-cbc-decrypt` splits into 16,384 forced regions with 4,096 replays at every
width, because tiny-AES-c rewrites `ctx->Iv` for every 16-byte block (see the
[forced admission study](../forced-admission-complete/README.md)). This study rewrites the kernel so
that the grains share no memory word, and runs it on the explicit task route. It is an explicit result:
the caller splits the call, and nothing discovers the split.

## Method

`scripts/research/cases/aes-grain.c` includes the pinned tiny-AES-c source and adds `decrypt_grain`,
an out-of-place decrypt of blocks `[first, first + count)` whose chaining value is the preceding
ciphertext block (or the supplied IV for block 0). The 4,096 blocks of a 64 KiB call run as eight
grains of 512 blocks, one per worker, each about 0.14 ms of cipher work. Two builds differ only in the
private context: `stock` keeps the corpus layout (8 MiB, with a 4 MiB arena that `corpus_reset`
zeroes and AES never uses), and `small` drops the arena and declares 1 MiB. Both keep the reset on:
every call restores an `InstanceCheckpoint`, which compares every page of the context.

Equality first. 120 generated inputs (seed 20261029, 16 B to 64 KiB, extreme keys and IVs, grain sizes
1, 7, 288, 290 and 4,096 blocks, grains run last to first) give the same bytes and return as the
unmodified `AES_CBC_decrypt_buffer`, for both builds (`diff-small.json`, `diff-stock.json`). The
entry also equals the corpus artifact (output SHA256 `8164d6ea...41bb`), including eight 512-block
ranges run in shuffled order.

Timing: 3 independent sessions of 25 paired rounds after 3 warmups on the Ryzen machine (Node 26.10.0,
cores 4 to 11, `nice -n 19`, `powersave` governor, load average 0.24 to 0.28), one pool alive at a time
(the [focused repeat](../focused-repeat/README.md) method). Each round runs three arms in alternating
order: `control_reset`, the serial entry with the same checkpoint reset the pool uses (the matched
control), `control_hot`, the serial entry with no reset, and the pool of `TaskPool` workers.
Every sample compares the 64 KiB output with the expected bytes.

## Results

Width 8, medians per session.

| Build | Session | Speedup vs matched control | vs no-reset control | Range vs matched | Pool ms | Matched ms | No-reset ms | Pool CPU ms | Worker reset ms | Worker compute ms | Dispatch ms |
| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| small | 1 | 2.68x | 2.62x | 1.50 to 4.94 | 0.41 | 1.09 | 1.06 | 1.87 | 0.049 | 0.234 | 0.175 |
| small | 2 | 2.12x | 2.05x | 1.08 to 2.93 | 0.51 | 1.09 | 1.06 | 2.18 | 0.049 | 0.265 | 0.246 |
| small | 3 | 2.34x | 2.30x | 1.22 to 2.93 | 0.47 | 1.09 | 1.06 | 2.31 | 0.053 | 0.267 | 0.193 |
| stock | 1 | 0.74x | 0.63x | 0.56 to 1.14 | 1.77 | 1.29 | 1.05 | 9.14 | 1.270 | 0.140 | 0.965 |
| stock | 2 | 0.89x | 0.66x | 0.57 to 1.22 | 1.59 | 1.35 | 1.06 | 9.05 | 1.229 | 0.147 | 0.646 |
| stock | 3 | 0.72x | 0.56x | 0.51 to 0.94 | 1.90 | 1.35 | 1.06 | 7.03 | 0.832 | 0.153 | 1.345 |

- **The 1 MiB build clears the 2x bar** in all three sessions (2.12x to 2.68x against the matched
  control and 2.05x to 2.62x against a serial run with no reset), with process CPU 1.7x to 2.1x of
  the serial call. The width-1 pool is 0.81x to 0.83x, so the gain comes from the split.
- **The 8 MiB build does not** (0.72x to 0.89x). Cipher compute drops from about 1.1 ms to 0.14 to 0.27 ms
  per worker in both builds. The difference is the reset: each worker compares 8 MiB in 0.8 to 1.3 ms,
  against 0.05 ms for 1 MiB, and eight workers scanning 64 MiB at once is slower per worker than one
  worker alone (0.2 ms at width 1).
- **The lever is the size of the private context.** The reset is unchanged, and the stock layout
  carries a 4 MiB arena that this kernel never touches.
- **Default admission still finds no plan** for either build: `prepare` reports a start function, data
  segments that need initialization isolation, a required shared memory and no region at the 200,000
  unit floor, and `Folio.run` runs the original module serially with no worker. This is not an
  automatic speedup.

Limits: one kernel, one machine for the rig record, and a spread across sessions of 2.12x to 2.68x. An
earlier run of the same code on a busy Apple M2 Pro (load 5 to 5.8, from other jobs) read 0.75x to
0.93x for the 8 MiB build, and its raw samples are not part of this record. The 64 KiB call is 1.1 ms serially, so a
caller needs calls of this size or larger. The result says the explicit route can split a single call
when the grains are independent by construction and the context is sized to the kernel, which the
corpus did not do.

## Reproduction

```sh
node scripts/research/grain-build.ts small
node scripts/research/grain-build.ts stock
node scripts/research/grain-diff.ts small
node scripts/research/grain-bench.ts out.jsonl 25 3 small
node scripts/research/grain-summarize.ts out.jsonl
```

`scripts/research/grain.sh SESSIONS ROUNDS [OUTPUT_DIRECTORY]` runs both builds for each session under
the timing lock with `nice -n 19` and cores 4 to 11. It needs the corpus built first.

## Artifacts

- `small-1.jsonl` to `small-3.jsonl`, `stock-1.jsonl` to `stock-3.jsonl`: raw records, an environment
  row and 25 rounds of three arms at widths 8 and 1.
- `*.summary.json`: medians per width from `grain-summarize.ts`.
- `diff-small.json`, `diff-stock.json`: the equality check with every case.
- `before.log`: memory, load and governor at the start.
- `source.tar.gz`: `src/`, `scripts/research/` and `package.json` as run.
- `manifest.json`: byte lengths and SHA256 digests.
