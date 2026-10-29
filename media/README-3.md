# Corpus Denominators

Question: how many of the corpus programs reach each stage, from build to a measured speedup, and
what does the corpus not represent?

The table counts distinct things. A project is an upstream source tree, a kernel is one exported
entry of a library, and a full application would be a program that a user runs. The corpus has
nine projects and 21 kernels. It has no full application and no database workload.

| Stage | Count | Source |
| --- | ---: | --- |
| Projects | 9 | [upstream](../upstream/README.md) |
| Kernels selected and built | 21 of 21 | [upstream](../upstream/README.md) |
| Kernels whose Folio and native runs match in all 8 MiB, returns and effects | 21 of 21 | [upstream](../upstream/README.md) |
| Kernels with an automatic plan under default admission | 0 of 21 | [upstream](../upstream/README.md) |
| Kernels that dispatch workers under default admission | 0 of 21 | [default entry repeat](../default-entry-repeat/README.md) |
| Kernels that receive regions at threshold 0 | 11 of 21 | [forced admission](../forced-admission-complete/README.md) |
| Of those, kernels faster than native | 0 of 11 | [forced admission](../forced-admission-complete/README.md) |
| Input profiles exact against a fresh native instance | 210 of 210 | [varied inputs](../varied-inputs/README.md) |

Explicit independent operations are a different route with its own denominator. Kernels of 21 with
a paired median speedup of at least the bar at eight batched `TaskPool` workers:

| Machine and reset policy | At least 1x | At least 2x | At least 3x |
| --- | ---: | ---: | ---: |
| Ryzen, whole arena | 5 | 2 | 1 |
| Ryzen, learned pages | 21 | 18 | 13 |
| Ryzen, checkpoint | 21 | 8 | 3 |
| M2 Pro, whole arena | 21 | 14 | 8 |
| M2 Pro, learned pages | 21 | 17 | 15 |
| M2 Pro, checkpoint | 21 | 20 | 9 |

The numbers are from [reset policies](../reset-policies/README.md). They need the caller to name
the independent operations and reset private contexts. They do not come from automatic extraction.

## Reproduction

```sh
node scripts/research/denominators.ts results/corpus results/corpus/denominators/denominators.json
```

## Artifacts

- `denominators.json`: every count in the tables, derived from the studies above.
- `manifest.json`: byte lengths and SHA256 digests.
