# Current image delivery on Free

The current 61,852,825-byte embedded PHP image uploads and instantiates on Free.
Wrangler reports 60,406.52 KiB uncompressed, 17,976.75 KiB gzip and 2 ms startup. This
specific bundle fits the documented 64 MiB Worker limit. The same initialized pages
can also be fetched as twelve files and copied into the original module's imported
memory. This proves delivery/instantiation, separate from a PHP or Drupal render.

| Path             | Successful/attempted | Unchecked fresh-object CPU/wall median | Unchecked repeated-object CPU/wall median |
| ---------------- | -------------------- | -------------------------------------- | ----------------------------------------- |
| Original module  | 23/24                | 14/17 ms (n=9)                         | 15.5/16 ms (n=10)                         |
| Embedded image   | 23/24                | 49/53 ms (n=9)                         | 49/50 ms (n=10)                           |
| Asset-copy image | 20/24                | 92/543 ms (n=7)                        | 98.5/432 ms (n=10)                        |

These are stored Durable Object invocation meters in whole milliseconds. Every
request instantiates a new module instance. The forwarding Worker, client latency
and full-memory check scans are separate. The original arm initializes 64 MiB;
image arms initialize 86,769,664 bytes. Image bytes and larger memory therefore
cost more to instantiate, even though actual restored applications can skip work.

All 11 completed full-memory FNV checks match their locally computed expectation;
one planned check did not reach the object. The full scans cost roughly 1.4 s CPU,
so they are excluded from ordinary cost samples. This 32-bit check is a consistency
test, not a cryptographic proof or evidence of shared physical pages.

The six failed measurement attempts remain in `raw.jsonl`. Five were provider
`Worker not found.` errors before object execution; one was a provider 404. The
initial baked deploy exhausted a six-second readiness window and contributed no
measurements. Its later diagnostic captures 404 then 200 readiness and succeeds.
The initial virtual-import build failure is also retained in `summary.json`.
No application limit or runtime behavior was changed to obtain success.

All temporary Workers/classes were retired, and each post-arm account snapshot
equals baseline. The study used zero application SQL rows, 72 measurement attempts
and 240 completed asset reads, plus bounded readiness/API requests. Account data,
disposable tokens, raw provider metadata and captured heap images remain private.
Published module/object cohorts are ordinal observations, not isolate identities.

| Artifact                     | Contents                                                          |
| ---------------------------- | ----------------------------------------------------------------- |
| [raw.jsonl](raw.jsonl)       | All 72 attempts, sanitized responses and observed cohorts         |
| [meters.jsonl](meters.jsonl) | Joined provider meters, keeping Worker and object separate        |
| [summary.json](summary.json) | Deploy sizes/startup, failure records, checks, meters and cleanup |

See the [method](../../../../experiments/bootimage/research/METHOD.md) and
[reproduction](../../../../experiments/bootimage/research/README.md). The
[provider limits](https://developers.cloudflare.com/workers/platform/limits/)
document 64 MiB per Worker and 25 MiB per asset; the actual upload above verifies
feasibility for this bundle, not every application surrounding it.
