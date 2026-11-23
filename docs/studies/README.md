# Studies

The studies explain what the experiments in `experiments/` and the records in `results/` measured, how, and what the numbers mean. Each page gives the question, the instrument, the design, the results with their sources, the reading, and what is closed and what stays open. The full evidence and its limits are in [the technical report](../../TECHNICAL_REPORT.md), and the limits that apply to a deployment are in [Limits](../limits.md).

| Page                                                        | What it covers                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [Storage Resets](storage-resets.md)                         | Which alarm and commit shapes reset a Durable Object, the 5 s alarm floor, the idle floor and the commit ladder            |
| [Continuation Across Events](continuation-across-events.md) | Claims C1 to C9, the PHP park, the platform signal, boundary commits and the deployed PHP runs                             |
| [Elastic Memory](elastic-memory.md)                         | Paging a guest's memory, the cost of translating every access, compressed pages, narrow arenas and the dynamic guard count |
| [Boot Images](boot-images.md)                               | Baked boot images: the saving, delivery on the edge, stale state, secrets and the replay contract                          |
| [Memory Accounting](memory-accounting.md)                   | What the platform memory meter counts, the memory ladder, storage spill and the growth governor                            |
| [Parallel Execution](parallel-execution.md)                 | Scaling, the explicit pools, certified folds, ownership certificates and the router gates that were not met                |

Each page links to its module page and to the report section that holds the full record. For combinations of these features in code, see [Advanced Usage](../../ADVANCED_USAGE.md).
