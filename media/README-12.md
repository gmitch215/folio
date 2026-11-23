# SQLite Lanes

Question: can a program that was never written to run in parallel, SQLite, run faster on managed lanes when each lane keeps its own instance over a shard of the data and the owner merges the partial results?

## Method

SQLite 3.50.4 compiled freestanding to a 1,003,837-byte WebAssembly module (single thread, read-only deserialized image). The fixture is a deterministic table of 1,000,000 rows (`id`, `k INTEGER`, `v INTEGER`, `s TEXT` of 24 bytes), a 52,772,864-byte image whose SHA-256 matches the one used for the Node task-pool measurements. The table is also split by rowid range into 4 and 8 shard images of at most 14 MiB, each a complete database with the same schema.

One Worker script with 13 Durable Object names: one `serial` object that holds the whole table (shipped in two parts), four `shards-4` objects and eight `shards-8` objects. Each object loads its image once and keeps the SQLite instance, so queries are warm. For each of five queries the owner runs three arms, interleaved and rotated, 12 repetitions after 2 warmups:

- `serial`: one object, whole table.
- `shards-4` and `shards-8`: the owner sends the query to every shard at once and merges the partials with the merge declared for that query (counts and sums add, group tables merge, top-10 lists merge).

The queries are an index range aggregate, a full-scan `GROUP BY` on `k % 64`, a `LIKE '%x%'` scan, a join with a 1,000-row table and a top-10 by a non-indexed column. A query with no declared merge is refused. The recursive CTE and `CREATE INDEX` are refused because each row depends on the previous one. Every merged result is compared byte for byte with the serial result. Lane work is also counted in SQLite virtual-machine steps, because a Worker's clock does not advance during compute.

## Results

Median client wall in ms over the 12 repetitions, deployed on a paid account, each figure including the client round trip to the owner:

| Query | Serial | 4 shards | 8 shards | Speedup at 4 / 8 |
| --- | --- | --- | --- | --- |
| range aggregate | 192.6 | 94.5 | 80.2 | 2.04 / 2.40 |
| group by | 2,208.4 | 413.4 | 228.2 | 5.34 / 9.68 |
| LIKE scan | 253.2 | 107.7 | 92.0 | 2.35 / 2.75 |
| join | 480.6 | 174.4 | 117.2 | 2.76 / 4.10 |
| top-10 | 799.4 | 289.4 | 211.4 | 2.76 / 3.78 |

- All 178 returned samples were exact. Two samples (one in `topk` at 4 shards, one in `group` at 8 shards) received a 409 because a shard object had been evicted, and the owner reloaded it (1.0 to 1.4 s); they carry no result and are not counted as mismatches or speedups.
- The total VDBE steps are the same in every arm of a query (for example 19.0 million for the group-by in all three arms), so the shards do the same work.
- Cold load: the whole table took about 1.9 s per 26 MB part; each 13 MB shard about 1.0 to 1.15 s. The measured speedups are for warm shards.
- The group-by speedup at 8 shards (9.7x on 8 lanes) is above the lane count. Wall per VDBE step is about 116 ns in the serial object and at most about 95 ns per lane in an 8-way shard (that bound includes the fixed round trip), which fits a smaller working set per lane. A Node control found that one worker on a one-eighth shard runs 2.2 times faster per row than one-eighth of the whole-table time, and neither a page cache sized to the shard nor the whole-table cache changed it. About 2.2x of the group-by figure is therefore a single-thread effect of the smaller table, and the cause of that effect is not isolated.
- The run created and deleted its own script and Durable Object class: no leftover resources and no foreign changes.

## Scope

- One account, one coordinator location, one fixture and five queries. The merges are declared by hand for these queries; a general query needs a planner that proves a merge.
- Speedups use a warm shard set. Shards must stay resident; an evicted shard costs a reload of 1 to 1.4 s.
- The serial arm holds the full 52.7 MB table in one 128 MB isolate, and it fit.
- Owner CPU and lane CPU were not parsed from the tail events; the record carries client wall and VDBE steps.
- The tail events here keep timing, outcome, route and data center only.

## Artifacts

- `run/raw.jsonl`: every request, failures included.
- `run/samples.json`: per-sample query, arm, equality, warm flag, VDBE steps and wall.
- `run/loads.jsonl`: the shard uploads and their walls.
- `run/summary.json` and `run/environment.json`: medians, counts, leftovers and the run record.
- `run/tail.jsonl`: scrubbed tail events.

## Reproduction

```sh
FOLIO_SQLITE_SOURCE=/path/to/sqlite-amalgamation node experiments/sqlite-lanes/prepare.ts
node experiments/sqlite-lanes/run.ts --dry-run
FOLIO_CLOUDFLARE_ACCOUNT_ID=... FOLIO_CLOUDFLARE_API_TOKEN=... node experiments/sqlite-lanes/run.ts
node scripts/research/lane-evidence.ts experiments/sqlite-lanes/runs/<name> results/managed/sqlite-lanes/run
```
