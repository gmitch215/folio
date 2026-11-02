# Record-Level Rig

Question: which of the 30 bulk drivers speed up under automatic admission, forced admission and the explicit private-context route on a quiet machine, and does the order of the arms change the answer?

## Method

Each driver (`scripts/research/c21-kernels.ts`) runs `n` independent records through one unmodified corpus entry and compares every output with the native serial run. The instrument is `scripts/research/c21-bench.ts` in timed mode: two warmups, then five measured rounds, width 8, native and arm alternating within a round.

The machine is a Ryzen 9 9900X under the timing lock with `nice 19` and CPUs 4 to 11 (Node 26.10.0, `powersave` governor). Two sweeps:

- `configurations.tar.gz` and `summary-*.json`: four configurations (`base`, `windows` with read windows and the read summary, `second` with the second-chance option, `all` with the three together), three sessions each, all arms in one process per driver in the order automatic, forced, explicit, explicit-1. Machine load 0.9 to 3.7. These runs predate the cold-start change described in the technical report.
- `arms.tar.gz` and `arms-table.md`: the tree with that change, three sessions, a fresh process for each arm of each driver (`scripts/research/c21-arms.sh`), machine load 0.9 to 2.

## Results

`arms-table.md` holds the median speedup over sessions and the sessions above 1.0 for every driver and arm. Automatic admission wins on 7 of 30 drivers (SHA-256 2.01, MD5 1.46, SHA-1 1.55, miniz CRC-32 1.52, MD5 with slot output 1.60, AES-CTR 1.21, LZ4 compress 1.06), forced admission on 7 of 30, and the explicit route on 26 of 30 (1.48 to 3.64 for 25 of them). Every sample in both sweeps is equal to the serial output.

- In the one-process sweep the forced and explicit arms ran after the automatic arm and inherited optimized code of the same module, so the forced column there is not comparable with the automatic one. The automatic columns and the explicit columns are unaffected: the explicit medians agree between the two sweeps (AES-CBC decrypt 3.51 and 3.50).
- The 6502 driver shows it most: forced after automatic 1.96, forced alone in a fresh process 0.16 to 0.17.
- The raw samples are read with `scripts/research/c21-summary.mjs` for the one-process sweep and `scripts/research/c21-arms-table.mjs` for the fresh-process sweep.

## Scope

- One machine, 30 drivers, three sessions of five rounds. A median over three sessions is not a confidence interval; a cell whose sessions disagree about 1.0 is marginal.
- The sweeps used different trees (the second includes the cold-start change), so a difference between them mixes the change with the arm order.
- The shared-code explanation for the order effect is inferred from the order swap and was not checked in V8.
