# Results

Measurements are grouped by topic and named study. Each study has a README with its
instrument, artifacts and reproduction steps. Dates, runtime versions, source digests,
parameters and sample counts are recorded in the data.

| Topic                                    | Evidence                                                    |
| ---------------------------------------- | ----------------------------------------------------------- |
| [Execution](execution/README.md)         | Automatic extraction, scaling, placement and admission      |
| [Memory](memory/README.md)               | Shared backing, large arenas and page leases                |
| [Compatibility](compatibility/README.md) | Consumer modules, PHP rendering and source archives         |
| [Compiler](compiler/README.md)           | Preparation and generated-function counts                   |
| [Tasks](tasks/README.md)                 | Explicit task pools, runtime compatibility and CPU topology |
| [PHP](php/README.md)                     | Requests, render work, SQL effects and deployment           |
| [Boot](boot/README.md)                   | Boot images, delivery, eligibility, replay and residency    |
| [Browser](browser/README.md)             | Physical sharing, extraction and consumer execution         |
| [Managed](managed/README.md)             | Copied-snapshot lane validation                             |
| [Portability](portability/README.md)     | Host bridge, runtime capabilities and concurrency           |
| [Analysis](analysis/README.md)           | Work/span models and their controls                         |
| [Verification](verification/README.md)   | Historical test and verification records                    |

## Provenance

[index.json](index.json) records the original v1 path, byte count and SHA256 for each
migrated artifact. Historical raw files, summaries and source archives retain their original
bytes. Original names inside records and archives identify the measured run; the index resolves
them to the current layout.

New studies use short role names such as `raw.jsonl`, `summary.json`, `environment.json`,
`source.tar.gz` and `run.log`. Use mechanism names for separate arms and record the reason
for a repeat in its README. Add a new record instead of overwriting a completed run.

## Reproduction

From the repository root:

```sh
node scripts/research/evidence.ts
node scripts/research/evidence.ts --summaries
bun scripts/analyze/run.ts
```

The first command verifies every historical artifact. The second regenerates summaries in a
temporary copy and compares their bytes. The last writes regenerated summaries into this tree.
See [scripts](../scripts/README.md) for toolchains and external consumer inputs, and
[experiments](../experiments/README.md) for local and deployed procedures.

Local timing, deployed latency, CPU meters and billing quantities use different instruments.
A successful comparison does not imply parallel worker dispatch; the execution reports record
routing separately.
