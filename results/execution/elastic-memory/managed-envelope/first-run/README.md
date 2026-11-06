# First Run

The first managed deployment. It completed one executor segment, then saw a propagation 404 on readiness and stopped. Its records are kept as they were:

- `raw.json`: the run's record, with `failure` set.
- `failure-body.json`: the response body of the failed request.
- `cleanup.json`: the first cleanup. It records the new script as a difference, so `ownResourcesRestored` is false.
- `cleanup-later.json`: a later inventory check. It shows the account back at baseline.
- `cleanup-errors.jsonl`: the owner clears that returned 404 during the first cleanup.
- `source.json`: the first run's manifest, with the run identifier replaced by `<run-id>`.

The final run is in the parent directory. See its [README](../README.md).
