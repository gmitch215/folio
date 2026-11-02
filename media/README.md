# SQLite Lanes

Shards a SQLite fixture across Durable Object lanes. Each `ShardObject` keeps one SQLite instance over its shard, an image of the same schema with the rows of one rowid range. The owner sends a query to every shard at once, each shard returns a partial result, and the owner merges the partials. The merge for each query is declared in `queries.ts`. A query with no declared merge is refused, not guessed.

```sh
FOLIO_SQLITE_SOURCE=/path/to/sqlite node experiments/sqlite-lanes/prepare.ts # dir holds sqlite3.c and sqlite3.h
node experiments/sqlite-lanes/run.ts --dry-run                               # the plan, counts and list-rate price; no Cloudflare call
node experiments/sqlite-lanes/run.ts                                         # live, paid account
```

`queries.ts` is the catalog and the merges, `sqlite.ts` the module wrapper, `coordinator.ts` the owner Worker and the `ShardObject` class, `prepare.ts` the module and fixture build, `ship.ts` the uploads, `plan.ts` the schedule, cap and price, `local.ts` the local workerd harness, `c/` the freestanding SQLite build sources.

The live run writes `runs/<name>/` (ignored). Export the evidence record with `node scripts/research/lane-evidence.ts experiments/sqlite-lanes/runs/<name> <target>`.
