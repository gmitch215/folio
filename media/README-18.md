# Initializer Repeat

Question: do the initializer timings of the [initializer study](../corpus/README.md) hold when
nothing else runs on the host?

The earlier run overlapped other local work. This repeat runs the same three arms on the 21 fixed
corpus initializers, 15 paired rounds each: conventional initialization, a fresh instance followed
by `applyImage`, and a whole-memory application cache.

## Results

Paired median speedup over conventional initialization on the Ryzen machine:

| Arm | Isolated repeat | Earlier run |
| --- | ---: | ---: |
| Image restore | 1.08x to 1.40x | 1.00x to 2.05x |
| Application cache | 0.52x to 0.94x | 0.69x to 1.20x |

Restoring an image after instantiation is modestly faster than running these initializers. The
application cache is slower than initializing on every kernel. The earlier run overstated both, so
use these figures for the corpus. They say nothing about the PHP image, whose
[lifecycle](../lifecycle/README.md) saving comes from a much larger initialization.

All 945 samples match: complete memory and returns equal across arms. All 21 bake attempts refuse
the module's start section, so `applyImage` after a fresh instantiation is the route measured.

## Reproduction

```sh
node scripts/research/boot-eligibility.ts build/research/initializer 15
node scripts/research/analyze.ts build/research/initializer/raw.jsonl summary.json
```

The record ran through `scripts/research/matched.sh` on Linux with Node 26.10.0, `nice -n 19`,
cores 4 to 11 and a shared timing lock.

## Artifacts

- `ryzen.jsonl`: raw records, 945 samples.
- `ryzen.summary.json`: paired summary.
- `manifest.json`: byte lengths and SHA256 digests.

The source archive is in [reset-policies](../../corpus/reset-policies/source.tar.gz).
