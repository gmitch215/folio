# Elastic Memory

Can a program address a logical heap larger than one isolate's memory while the executor keeps a fixed amount of Wasm memory? Four studies answer parts of that question. Each one has its own README and METHOD.

| Study                                      | Question                                                                 | Instrument                                |
| ------------------------------------------ | ------------------------------------------------------------------------ | ----------------------------------------- |
| [capacity-local](capacity-local/README.md) | Does a 192 MiB to 2 GiB logical heap run exactly in 327,680 Wasm bytes? | `scripts/probe/elastic/run.ts` (local)    |
| [migration-controls](migration-controls/README.md) | What does each migration control move, and what does elastic execution move? | `run.ts` (touched receivers), `sweep.ts` (frame sweep) and `capacity-local/raw.json` |
| [managed-envelope](managed-envelope/README.md) | Does the 192 MiB fixture complete on the Free managed plan?             | `experiments/elastic` (one live run)      |
| [latency-anatomy](latency-anatomy/README.md) | Where do the 392 s of the managed run go?                                | `scripts/research/elastic-latency-split.mjs` and `elastic-model.ts` |

The local studies run in Node on one machine. The managed study is one live run on the Cloudflare Free plan. Local timings in these studies are diagnostic observations, not latency claims. The managed run's latency is a single run.

## Redaction

Tracked files hold no account identifiers, workers.dev hosts, bearer tokens or absolute local paths. `scripts/research/redaction-scan.ts` checks every file. Three kinds of change were made to the original scratch evidence:

- The temporary backing directory in `raw.json`, `full-scan.json` and `compiled.json` is replaced by a placeholder.
- The run identifier in `requests.jsonl` and in `source.json` is replaced by a placeholder.
- The account inventories (`baseline.json`, `after.json`, `namespaces.json`) are reduced to counts, with the SHA-256 of each original recorded in `managed-envelope/inventory-counts.json`.

The unpromoted files are `tail-valid.log` (it carries workers.dev hosts) and `tail.log` (it carries a local home path). `read-only.json` is an early pilot outside the 21-case count and is not promoted. Each study's METHOD gives the original hashes.

## Reproduction

From the repository root, after `bun run build:c` and the dependencies are installed, each study's METHOD lists its commands. Offline analysis needs only the files in this directory, except the backing verification and the managed tail summary, which need scratch files that are not promoted.
