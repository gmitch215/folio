# Idle Restart Floor

How often does a small commit on an idle, lightly written SQLite Durable Object fail with a reset
over several hours? The object gets no requests. Its own alarm drives every write, so the result is
the background failure rate of ordinary small commits, with no load to explain a reset.

## Files

| File             | Role                                                            |
| ---------------- | --------------------------------------------------------------- |
| `worker.mjs`     | the `Idle` Durable Object, its alarm chain and the Worker entry |
| `wrangler.jsonc` | one SQLite-backed class, `Idle`, bound as `I`                   |
| `idle.ts`        | the `start` and `stat` driver; writes `runs/idle-<time>.json`   |

## Alarm Chain

Each alarm run inserts a row into `started`, syncs, inserts a row into `done`, syncs, and sets the
next alarm. The `started` and `done` tables share the run number `k`. The `meta` table keeps the
run counter (`alarmStarts`), the instance id last seen by the alarm handler (`inst`) and the number
of distinct instances seen (`instances`).

A run that fails at either commit leaves a `started` row with no `done` row. The handler does not
catch exceptions, so a failed run surfaces in the logs.

The chain stops itself. The run that reaches `MAX_FIRES` does not set another alarm. At the
defaults (180 seconds, 80 runs) that is about four hours, so a deployment left running ends by
itself.

## Running

```sh
npx wrangler deploy --config experiments/idle-floor/wrangler.jsonc
WORKER_URL=$WORKER_URL node experiments/idle-floor/idle.ts start
WORKER_URL=$WORKER_URL node experiments/idle-floor/idle.ts stat
npx wrangler delete --config experiments/idle-floor/wrangler.jsonc
```

`start` sends one request per object to create it, then starts its chain once. `stat` prints a
row per object and the totals, and writes the same data to `runs/`.

| Variable     | Default | Use                                      |
| ------------ | ------- | ---------------------------------------- |
| `WORKER_URL` | none    | origin of the deployed Worker (required) |
| `OBJECTS`    | `10`    | number of objects                        |
| `OUT`        | `runs/` | output directory                         |

The Worker reads `PERIOD_MS` (default `180000`) and `MAX_FIRES` (default `80`) from its
environment. Each `stat` call adds a request to every object.

## Reading the Output

| Field                | Meaning                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `fires`              | alarm runs that began (`started` rows)                              |
| `completed`          | runs that wrote their `done` row                                    |
| `failed`             | `fires` minus `completed`: started runs with no `done` row          |
| `startsMinusCounter` | `started` rows minus `alarmStarts`; zero when every run writes both |
| `instanceChanges`    | distinct instance ids seen by the alarm handler, minus one          |
| `wilsonUpper95`      | 95% Wilson upper bound on `failed / fires`                          |

If the platform retries a run that did not commit, its rows look the same as a failed run's, so
the schema cannot separate the two. The `started` and `done` rows give counts per run number only.

## Results

One deployment, run from 2026-11-22 04:56 UTC for four hours. Ten objects, 80 alarm runs each, no
requests after start.

| Measure                                | Value |
| -------------------------------------- | ----- |
| Alarm runs begun                       | 800   |
| Runs completed                         | 800   |
| Failed runs (started, no done row)     | 0     |
| Instance changes beyond the first      | 790   |
| 95% Wilson upper bound on failure rate | 0.48% |

No failures in 800 fires. The 95% upper bound on the failure rate is 0.48%.
