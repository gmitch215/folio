# Held-Out Workloads

Question: do the findings from the 30 corpus drivers hold on programs that were pinned and built before anyone looked at how Folio treats them, and does a serial-work gate fitted on the corpus beat the first-batch admission rule on them?

## Method

Six open source projects were chosen from the candidate list of the selection rule written before the build (a permissive license, a freestanding wasm32 build with clang and no Emscripten, deterministic output, a natural entry point, a record that one call of that entry takes), pinned to a tag or commit, checked against the license file in the pinned archive, and added as eight bulk drivers whose library sources are unedited. The pin rule was fixed before building: the newest tag, unless it is more than two years older than the default branch head, in which case the head commit.

| project | pin | commit | license | drivers (records per call set, one record) |
| --- | --- | --- | --- | --- |
| brotli | tag v1.2.1 | db24a98aed38a16de78cc05ca15cdd8dc2a0d92d | MIT | compress (48 x 32 KiB of text), decompress (64 streams of about 12 KB) |
| wyhash | head, final version 4.3 | e4764a0b637d34d3421a7760affada9288b625a8 | Unlicense | hash (4096 x 1 KiB) |
| BLAKE2 reference | head | ed1974ea83433eba7b2d95c5dcd9ac33cb847913 | CC0-1.0 | blake2b, 64 byte digest (256 x 64 KiB) |
| QOA | head, no tags | bc0589710ff6aa2f50e08fb4d0a815d567bc0f3e | MIT | encode and decode (32 frames of 5120 stereo samples) |
| yyjson | tag 0.13.0 | 6447536015f3d600f3d65323b10976103b337ca7 | MIT | read (1024 documents of about 3.8 KiB) |
| md4c | tag v0.6.0 | 7fc1815a5eeba2af7d6120a76202bf59f3b6e6e4 | MIT | Markdown to HTML (16 documents of 63 KiB) |

The record counts and sizes were fixed before any Folio arm ran on the final set and were chosen to differ: serial time per call set spans 0.86 ms to 58.7 ms and records per call set span 16 to 4096. Each driver builds, runs serially, is deterministic across two processes and matches an independent reference (Node `zlib` and `crypto`, `JSON.parse`, a round trip, hand-written CommonMark outputs for md4c, and a BigInt port of wyhash that is not a vendor test vector). Allocator users go through the bump allocator of `support-bulk.c`, one slice per record.

The gate was written down before these drivers ran, with its adoption rule (`results/corpus/slice-pool-census/admission-quality.md` holds the fit): admit when the serial work is at least 4 ms and the cost per record at least 50 us, in front of the protected route; adopt it as the default only if it misses no loop that automatic admission wins by more than 1.05x and its mean regret is not above automatic's. The parameters were fitted on the 30 corpus drivers and not changed afterwards.

The four arms ran on the Ryzen 9 9900X under the timing lock (`nice 19`, CPUs 4 to 11) with eight workers, three sessions of five rounds after two warmups, one fresh process per arm. `arms.md` is the table, `admission-quality.md` the scoring, `raw.tar.gz` every raw row and log.

## Results

Speedup over serial, median of the session medians (sessions above 1.0 in `arms.md`):

| driver | automatic | forced | explicit private contexts | in place |
| --- | ---: | ---: | ---: | ---: |
| blake2b | 1.84 | 2.19 | 2.11 | 3.46 |
| brotli compress | 1.00 | refused | 3.94 | fails output check |
| brotli decompress | 0.99 | 1.00 | 2.85 | fails output check |
| md4c HTML | 1.00 | 0.99 | 3.27 | fails output check |
| QOA decode | 0.98 | 0.98 | 2.17 | fails output check |
| QOA encode | 1.00 | 0.99 | 3.96 | fails output check |
| wyhash | 0.82 | 0.13 | 1.94 | 3.12 |
| yyjson read | 0.80 | 0.10 | 1.96 | fails output check |

Explicit private contexts win on all eight, 1.94x to 3.96x, with every output equal to serial. Automatic admission wins on one (BLAKE2) and refuses five loops (serial time at 0.98x to 1.00x); on the two it admitted where no tracked route wins it ran at 0.82x and 0.80x against 0.13x and 0.10x forced. The in-place route is exact on the two programs without an allocator (BLAKE2, wyhash) and fails or flakes on every program that allocates, the same class that fails in the corpus census.

The fixed gate fails both written conditions. It misses BLAKE2, which automatic wins at 1.84x, because BLAKE2 costs 42.4 us per record against the 50 us cut, and its mean regret on these eight is 0.154 against 0.089 for automatic admission. The gate is not adopted, and the per-record cut fitted on the corpus did not transfer.

## Scope

- Eight drivers from six projects on one machine, one record stream each. The loops are few, and a single winner (BLAKE2) carries the comparison between the gate and automatic admission.
- Three more projects that passed the license gate (minimp3, mpack, libexpat) were not built, and the 15 candidates refused for license are not in the set.
- The in-place failures are inferred to come from the shared allocator cursor, which the census control (`qoi-encode`) also shows; the cursor was not read.
