# Actual Drupal configuration eligibility

The consumer's current renewal code expands image reuse from **7/13 strict
configuration matches to 12/13 cases with config/entity reset**. All 39 safe-arm
first-render comparisons equal native status and normalized HTML. The enabled-module
change falls back to a fresh boot. The deliberately unguarded arm serves stale
site-name and theme-color output, demonstrating why admission or reset is needed.

| Change                             | Exact config key | Module key plus reset | Verified response |
| ---------------------------------- | ---------------- | --------------------- | ----------------- |
| Base                               | Image            | Image                 | 200               |
| Site name, email, timezone         | Fresh boot       | Image                 | 200               |
| Favicon setting, theme color       | Fresh boot       | Image                 | 200               |
| Enable `ban` module                | Fresh boot       | Fresh boot            | 200               |
| Maintenance state                  | Image            | Image                 | 503               |
| Cache invalidation, alias, content | Image            | Image                 | 200               |
| Private key, settings salt         | Image            | Image                 | 200               |

These are thirteen selected configurations and 52 executions, not a production
eligibility percentage. A settings change can leave this route's HTML unchanged;
the case proves admission and observed rendering under that change, not every
possible use of that setting. Module, glue, pack and host inputs are pinned.

The safe arms reproduce each case's independently booted key/salt hashes; 32
restored RNG triples and four login form IDs are unique in this cohort. All stream
and handle replays succeeded and renewal reported no errors. This is narrower than
arbitrary extension replay safety. See the [method](../../../experiments/bootimage/research/METHOD.md).

| Artifact                       | Contents                                                                   |
| ------------------------------ | -------------------------------------------------------------------------- |
| [raw.jsonl](raw.jsonl)         | Environment, pinned hashes and 52 samples, including the unsafe arm        |
| [summary.json](summary.json)   | Eligibility, equality, replay checks and derived statistics                |
| [phases.json](phases.json)     | Per-arm descriptive medians; mixed configurations are not a scaling cohort |
| [source.tar.gz](source.tar.gz) | Public harness and measured library/helper sources                         |

Reproduce with the [research harness](../../../experiments/bootimage/research/README.md).
The raw-file SHA256 is recorded in the summary. Interpreter/glue and the private
consumer renewal source are identified by digest; raw heaps and databases are not
published. Do not replace this record when rerunning.
