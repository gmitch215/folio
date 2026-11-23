# Continuation

Probes for running a Wasm guest across Durable Object alarm events: the CPU signal, JSPI chains,
checkpoints into SQLite, isolate lifetimes, boundary commits and deferred checkpoints. Each arm is a
Worker or a Node driver. Sanitized records are in [results/continuation](../../results/continuation/README.md).
The PHP variant is [Continuation PHP](../continuation-php/README.md).

| Arm                   | Question                                                                                                       | Environment     |
| --------------------- | -------------------------------------------------------------------------------------------------------------- | --------------- |
| [signal](signal/)     | Does an alarm event receive the CPU warning, and do JSPI and sync chains survive it?                           | Durable Objects |
| [durable](durable/)   | Does a checkpoint in SQLite let a 120,000-step chain finish exactly, and what does a checkpoint cost?          | Durable Objects |
| [life](life/)         | How long does an isolate live under a CPU chain, and when does it move?                                        | Durable Objects |
| [deferred](deferred/) | Does a checkpoint taken only on the same isolate keep the chain exact across moves?                            | Durable Objects |
| [local](local/)       | Are JSPI stop and resume, checkpoint and restore exact in Node, and what do the hash pass and checkpoint cost? | Node 26         |

The `deferred` arm also holds the boundary-commit mode (`mode=bc`) and its local run.

## Guests

`guests/` holds the WebAssembly sources. `build.ts` compiles the deployed arms' modules into each
arm's `build/`. `local/run.mjs` compiles its own modules into `local/runs/`.

- `burn.wat` a 64-bit LCG that polls the signal word at 1024.
- `jspi.wat` the same kernel with the LCG in a local, yielding through an import.
- `durable-guest.wat` the checkpointable chain guest used by `durable` and `deferred`.
- `hash.wat` the page hash, needs `--enable-multi-memory`.
- `local-guest.wat` and `local-guest-nopoll.wat` the local guest, with and without the poll.

The signal word is `__instance_signal` (1024). The runtime writes 24 to it shortly before the CPU limit.

## Run

Local arms need no account:

```sh
node experiments/continuation/local/run.mjs
node experiments/continuation/build.ts
npx wrangler dev --config experiments/continuation/durable/wrangler.jsonc --port 8788
node experiments/continuation/deferred/run.ts f0
```

Deployed arms read the account variables that `experiments/lib/cloudflare.ts` reads. Export them in
the shell first. Each arm snapshots the account before and after, and deletes its Worker at the end.
Run them one at a time:

```sh
node experiments/continuation/build.ts
node experiments/continuation/signal/run.ts snap-before
npx wrangler deploy --config experiments/continuation/signal/wrangler.jsonc
node experiments/continuation/signal/run.ts a1
npx wrangler delete --config experiments/continuation/signal/wrangler.jsonc --force
node experiments/continuation/signal/run.ts snap-after
```

Raw run output goes to each arm's `runs/` directory, which is git-ignored. Deployed records include
tail output, so they stay local. `export.ts` turns them into the study rows in `results/`.

## Evidence

```sh
node experiments/continuation/export.ts <directory with the php-poll-cost tab-separated files>
node scripts/analyze/continuation.ts
node scripts/research/evidence.ts
```

## Limits

Deployed arms are not run by the verifier. The `.mjs` drivers and Workers are plain JavaScript
outside the typecheck; `tsconfig.json` checks the TypeScript drivers and the exporter.
