# Initialized Drupal lifecycle

Fifteen paired rounds compare actual Drupal boot plus first render in fresh Node
processes. All 45 outputs equal native status and normalized HTML. Embedded images
and copied initialized memory save boot work; this is serial-work elimination,
with a separate heap per execution.

| Path              | Wall median | Aggregate CPU median | Paired speedup, 95% interval | CPU/native ratio |
| ----------------- | ----------- | -------------------- | ---------------------------- | ---------------- |
| Native            | 830.53 ms   | 1,412.78 ms          | 1.00×                        | 1.00             |
| Embedded image    | 444.73 ms   | 806.49 ms            | 1.903× [1.821, 1.972]        | 0.558            |
| Memory-image copy | 460.55 ms   | 814.66 ms            | 1.876× [1.786, 1.908]        | 0.578            |

Intervals bootstrap paired rounds in this one execution. They do not establish
independent replication or managed-platform render latency. The warm second render
medians are 66.02, 62.94 and 64.31 ms respectively: retaining an already initialized
application remains cheaper than restoring it. The copied-image path spends a
median 10.82 ms applying pages/globals. Renewal is included in total elapsed/CPU but
is not separately timed. Native rendering finishes with 69,992,448 heap bytes;
restored rendering uses 87,687,168, so this speedup carries a larger heap.

A separate image generation observation costs 10,366.68 ms elapsed and 11,362.81 ms
CPU, including boot/render, capture, bake, gzip, files and database backup. Baking
alone costs 3,947.95 ms. It produces a 61,852,825-byte Wasm module and 47,844,350-byte
encoded image. A model using these costs and cohort median savings breaks even at
27 embedded-image or 29 memory-copy boots by elapsed time, 19 by CPU. Distribution,
deployment, storage and retention are excluded; these are calculated thresholds,
not observed fleet outcomes. The generated heap is not safe to publish as raw data.

The capture restores four mutable globals, one filesystem stream, four named/sealed
host handles and initialization replay. All 30 restored RNG triples are unique;
key/salt hashes match native, and replay/renewal report no errors. This does not
serialize arbitrary JavaScript, changed function tables or external resources.

Current [deployed delivery](delivery/README.md) proves this embedded module can be
uploaded and instantiated on Free, alongside the asset-copy alternative. That
instrument uses stub imports and measures no Drupal rendering. Prior actual
managed host render evidence remains in [deployed-serve](../deployed-serve/README.md).

| Artifact                           | Contents                                                       |
| ---------------------------------- | -------------------------------------------------------------- |
| [raw.jsonl](raw.jsonl)             | 45 samples, exact environment, inputs and phase observations   |
| [summary.json](summary.json)       | Equality, safety, paired statistics and raw digest             |
| [phases.json](phases.json)         | Compilation, instantiation, first/warm render and heap medians |
| [generation.json](generation.json) | Separate generation observation and scoped amortization model  |
| [source.tar.gz](source.tar.gz)     | Public harness and measured library/helper sources             |

See [method](../../../experiments/bootimage/research/METHOD.md) and
[reproduction](../../../experiments/bootimage/research/README.md).
