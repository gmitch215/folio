# External Applications

Build and timing harness for W4b: upstream C programs run unchanged through Folio's automatic route. Nothing here edits an application. The programs are aobench (`ao.c`), FastLZ `6pack` and llama2.c `run.c`, cloned under `scratchpad/v11/w4/src/` at the revisions in `scratchpad/v11/w4/W4B-PREREG.md`.

## Files

- `vfs.c` is a small libc layer for the pieces the shim stubs out: `fopen` and friends over in-memory files, `printf` into an in-memory stdout, `sscanf` for hex bytes, `open`, `read` and `mmap` over input files, `drand48`, `clock_gettime` and `time`. It is linked first with `--allow-multiple-definition`, so its definitions win over the stubs in `final-cases/shim/shim.c`. I/O is ordinary Wasm code over memory; no host import is involved.
- `extra.h` is force-included. It declares `drand48` and pulls in `stdint.h`.
- `include/sys/mman.h` declares `mmap` for llama2.c.
- `build.ts` builds each program native and as Wasm. Two Wasm variants exist: `shared` follows `scripts/build/fixtures.ts` (atomics, shared memory) and `plain` follows `scripts/research/corpus.ts` (plain imported memory).
- `harness.ts` runs one fresh process per arm and round. Arms are `native`, `serial`, `folio` and `folio-force`. `folio-force` sets `minimumRegionWork: 0` and is a diagnostic only.
- `gen-text.ts` writes the seeded text input for 6pack.

## Usage

```sh
node scripts/research/external-apps/build.ts SRC_DIR OUT_DIR
node scripts/research/external-apps/harness.ts run DIR OUT.jsonl --variant plain --rounds 7
node scripts/research/external-apps/harness.ts summary OUT.jsonl
```

`DIR` holds `build/`, `input/` and `native-out/`. `inspect` prints what `prepare` found, and `decide` prints the router decision for `main` without dispatching it.
